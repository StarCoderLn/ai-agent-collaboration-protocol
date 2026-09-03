package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/agentlifecycle"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/executionproxy"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/matching"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

type fakeMatcher struct{ record matching.Record }

func (f fakeMatcher) RunMatching(context.Context, string) (matching.Record, error) {
	return f.record, nil
}
func (f fakeMatcher) LatestCandidates(context.Context, string) (matching.Record, error) {
	return f.record, nil
}
func (f fakeMatcher) RunWorkflowNodeMatching(_ context.Context, taskID, workflowNodeID string) (matching.Record, error) {
	f.record.TaskID, f.record.WorkflowNodeID = taskID, workflowNodeID
	return f.record, nil
}
func (f fakeMatcher) LatestWorkflowNodeCandidates(_ context.Context, taskID, workflowNodeID string) (matching.Record, error) {
	f.record.TaskID, f.record.WorkflowNodeID = taskID, workflowNodeID
	return f.record, nil
}

type fakeDispatcher struct {
	command      dispatch.LockCommand
	acknowledged bool
}

func (f *fakeDispatcher) ConfirmCandidate(_ context.Context, command dispatch.LockCommand) (dispatch.LockResult, error) {
	f.command = command
	return dispatch.LockResult{Assignment: domain.Assignment{
		ID: "assignment-1", TaskID: command.TaskID, WorkflowNodeID: command.WorkflowNodeID,
		AgentID: command.AgentID, AgreedAmountMinor: 9_007_199_254_740_993,
	}}, nil
}
func (f *fakeDispatcher) Acknowledge(_ context.Context, assignmentID, agentID string, accepted bool) (domain.Assignment, error) {
	f.acknowledged = true
	status := domain.AssignmentAcceptFailed
	if accepted {
		status = domain.AssignmentAccepted
	}
	return domain.Assignment{ID: assignmentID, AgentID: agentID, Status: status}, nil
}
func (f *fakeDispatcher) RetryFailedExecution(_ context.Context, taskID, actorID string) (dispatch.ExecutionRetryResult, error) {
	return dispatch.ExecutionRetryResult{
		TaskID: taskID, AssignmentID: "assignment-1", TransitionEventID: "event-1",
	}, nil
}
func (f *fakeDispatcher) RetryFailedWorkflowNodeExecution(
	_ context.Context, taskID, workflowNodeID, actorID string,
) (dispatch.ExecutionRetryResult, error) {
	return dispatch.ExecutionRetryResult{
		TaskID: taskID, WorkflowNodeID: workflowNodeID,
		AssignmentID: "assignment-node-1", TransitionEventID: "event-node-1",
	}, nil
}

type fakeAssignmentReader struct{}

func (fakeAssignmentReader) LatestForTask(context.Context, string) (dispatch.LockResult, error) {
	return dispatch.LockResult{Assignment: domain.Assignment{ID: "assignment-1"}}, nil
}
func (fakeAssignmentReader) LatestForWorkflowNode(_ context.Context, taskID, workflowNodeID string) (dispatch.LockResult, error) {
	return dispatch.LockResult{Assignment: domain.Assignment{
		ID: "assignment-node-1", TaskID: taskID, WorkflowNodeID: workflowNodeID,
	}}, nil
}

type fixedKeys struct{ secret string }

func (f fixedKeys) ActiveSigningKeys(context.Context, string) ([]string, error) {
	return []string{f.secret}, nil
}

type memoryNonces struct{ used map[string]bool }

func (m *memoryNonces) ReserveNonce(_ context.Context, _ string, nonce string, _ time.Time) (bool, error) {
	if m.used[nonce] {
		return false, nil
	}
	m.used[nonce] = true
	return true, nil
}

type fakeExecutionProxy struct {
	called bool
	body   []byte
	key    string
}

type fakeAgentLifecycle struct{ command agentlifecycle.Command }

func (f *fakeAgentLifecycle) Transition(_ context.Context, command agentlifecycle.Command) (agentlifecycle.Snapshot, error) {
	f.command = command
	pauseReason := "manual"
	return agentlifecycle.Snapshot{AgentID: command.AgentID, Status: domain.AgentPaused, PauseReason: &pauseReason, UpdatedAt: command.Now}, nil
}

func (f *fakeExecutionProxy) Forward(_ context.Context, _, _, _, key string, body []byte) (executionproxy.Response, error) {
	f.called, f.key, f.body = true, key, append([]byte(nil), body...)
	return executionproxy.Response{StatusCode: http.StatusOK, Body: []byte(`{"status":"executing"}`)}, nil
}

func TestInternalRoutesRequireServiceTokenAndForwardVerifiedActor(t *testing.T) {
	dispatcher := &fakeDispatcher{}
	server := Server{InternalToken: "internal-secret", Matcher: fakeMatcher{}, Dispatcher: dispatcher, AssignmentReader: fakeAssignmentReader{}}

	unauthorized := httptest.NewRecorder()
	server.Handler().ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/internal/tasks/task-1/assignments", strings.NewReader(`{"agentId":"agent-1"}`)))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected internal auth rejection, got %d", unauthorized.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/internal/tasks/task-1/assignments", strings.NewReader(`{"agentId":"agent-1"}`))
	request.Header.Set("Authorization", "Bearer internal-secret")
	request.Header.Set(headerInternalActor, "publisher-1")
	request.Header.Set("Idempotency-Key", "dispatch:task-1:1")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated || dispatcher.command.ActorID != "publisher-1" || dispatcher.command.TaskID != "task-1" {
		t.Fatalf("assignment route mismatch: status=%d command=%+v body=%s", response.Code, dispatcher.command, response.Body.String())
	}
	var responseBody struct {
		Assignment struct {
			ID                string `json:"id"`
			TaskID            string `json:"taskId"`
			AgreedAmountMinor string `json:"agreedAmountMinor"`
		} `json:"assignment"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &responseBody); err != nil ||
		responseBody.Assignment.ID != "assignment-1" || responseBody.Assignment.TaskID != "task-1" ||
		responseBody.Assignment.AgreedAmountMinor != "9007199254740993" {
		t.Fatalf("assignment JSON contract is unsafe or unstable: body=%s err=%v", response.Body.String(), err)
	}
}

func TestWorkflowNodeRoutesKeepTaskAndNodeIdentityInTheContract(t *testing.T) {
	dispatcher := &fakeDispatcher{}
	server := Server{
		InternalToken: "internal-secret", Matcher: fakeMatcher{}, Dispatcher: dispatcher,
		AssignmentReader: fakeAssignmentReader{},
	}

	request := httptest.NewRequest(
		http.MethodPost,
		"/internal/tasks/task-1/workflow-nodes/node-2/assignments",
		strings.NewReader(`{"agentId":"agent-3"}`),
	)
	request.Header.Set("Authorization", "Bearer internal-secret")
	request.Header.Set(headerInternalActor, "publisher-1")
	request.Header.Set("Idempotency-Key", "dispatch:node-2:request-1")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusCreated || dispatcher.command.TaskID != "task-1" ||
		dispatcher.command.WorkflowNodeID != "node-2" || dispatcher.command.AgentID != "agent-3" {
		t.Fatalf("workflow assignment lost target identity: status=%d command=%+v body=%s", response.Code, dispatcher.command, response.Body.String())
	}

	candidatesRequest := httptest.NewRequest(
		http.MethodGet, "/internal/tasks/task-1/workflow-nodes/node-2/candidates", nil,
	)
	candidatesRequest.Header.Set("Authorization", "Bearer internal-secret")
	candidates := httptest.NewRecorder()
	server.Handler().ServeHTTP(candidates, candidatesRequest)
	if candidates.Code != http.StatusOK || !strings.Contains(candidates.Body.String(), `"workflowNodeId":"node-2"`) {
		t.Fatalf("workflow candidates lost node identity: status=%d body=%s", candidates.Code, candidates.Body.String())
	}

	latestRequest := httptest.NewRequest(
		http.MethodGet, "/internal/tasks/task-1/workflow-nodes/node-2/assignments/latest", nil,
	)
	latestRequest.Header.Set("Authorization", "Bearer internal-secret")
	latest := httptest.NewRecorder()
	server.Handler().ServeHTTP(latest, latestRequest)
	if latest.Code != http.StatusOK || !strings.Contains(latest.Body.String(), `"workflowNodeId":"node-2"`) {
		t.Fatalf("workflow latest assignment lost node identity: status=%d body=%s", latest.Code, latest.Body.String())
	}
}

func TestExecutionRetryPersistsARecoveryFactThroughTheDispatcher(t *testing.T) {
	dispatcher := &fakeDispatcher{}
	server := Server{InternalToken: "internal-secret", Dispatcher: dispatcher}
	request := httptest.NewRequest(http.MethodPost, "/internal/tasks/task-1/execution-retry", nil)
	request.Header.Set("Authorization", "Bearer internal-secret")
	request.Header.Set(headerInternalActor, "publisher-1")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"transitionEventId":"event-1"`) {
		t.Fatalf("execution retry route mismatch: status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestInternalAgentLifecycleRequiresActorTypeAndIdempotency(t *testing.T) {
	lifecycle := &fakeAgentLifecycle{}
	server := Server{InternalToken: "internal-secret", AgentLifecycle: lifecycle}
	request := httptest.NewRequest(
		http.MethodPost,
		"/internal/agents/83100000-0000-4000-8000-000000000001/transitions",
		strings.NewReader(`{"event":"manual_pause"}`),
	)
	request.Header.Set("Authorization", "Bearer internal-secret")
	request.Header.Set(headerInternalActor, "0x1111111111111111111111111111111111111111")
	request.Header.Set(headerInternalActorType, "provider")
	request.Header.Set("Idempotency-Key", "pause:agent:request-1")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusOK || lifecycle.command.AgentID == "" || lifecycle.command.IdempotencyKey != "pause:agent:request-1" {
		t.Fatalf("lifecycle route mismatch: status=%d command=%+v body=%s", response.Code, lifecycle.command, response.Body.String())
	}
	if _, ok := lifecycle.command.Event.(domain.ManualPause); !ok || lifecycle.command.ActorType != agentlifecycle.ActorProvider {
		t.Fatalf("lifecycle event/actor was not constrained: %+v", lifecycle.command)
	}
}

func TestInternalAgentLifecycleAcceptsConstrainedAdminReviewDecisions(t *testing.T) {
	for _, testCase := range []struct {
		name, body  string
		assertEvent func(t *testing.T, event domain.AgentEvent)
	}{
		{
			name: "approve", body: `{"event":"admin_approve","reviewReason":"基础资料与服务端点已核验"}`,
			assertEvent: func(t *testing.T, event domain.AgentEvent) {
				approval, ok := event.(domain.AdminApprove)
				if !ok || approval.ReviewReason == "" {
					t.Fatalf("unexpected approval: %+v", event)
				}
			},
		},
		{
			name: "reject", body: `{"event":"admin_reject","reviewReason":"服务端点无法访问"}`,
			assertEvent: func(t *testing.T, event domain.AgentEvent) {
				rejection, ok := event.(domain.AdminReject)
				if !ok || rejection.ReviewReason == "" {
					t.Fatalf("unexpected rejection: %+v", event)
				}
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			lifecycle := &fakeAgentLifecycle{}
			server := Server{InternalToken: "internal-secret", AgentLifecycle: lifecycle}
			request := httptest.NewRequest(http.MethodPost, "/internal/agents/83100000-0000-4000-8000-000000000001/transitions", strings.NewReader(testCase.body))
			request.Header.Set("Authorization", "Bearer internal-secret")
			request.Header.Set(headerInternalActor, "0x1111111111111111111111111111111111111111")
			request.Header.Set(headerInternalActorType, "admin")
			request.Header.Set("Idempotency-Key", "review:agent:"+testCase.name)
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			testCase.assertEvent(t, lifecycle.command.Event)
		})
	}
}

func TestAgentAcknowledgementRequiresProtocolSignatureAndCannotBeForgedByAgentIDAlone(t *testing.T) {
	const secret = "agent-signing-secret"
	dispatcher := &fakeDispatcher{}
	verifier := &protocol.Verifier{Keys: fixedKeys{secret: secret}, Nonces: &memoryNonces{used: map[string]bool{}}}
	server := Server{Dispatcher: dispatcher, Verifier: verifier}
	body := []byte(`{"agentId":"agent-1","accepted":true}`)
	path := "/agent-callback/assignments/assignment-1/ack"

	unsigned := httptest.NewRecorder()
	unsignedRequest := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	unsignedRequest.Header.Set(protocol.HeaderProtocolVersion, protocol.ProtocolVersion)
	server.Handler().ServeHTTP(unsigned, unsignedRequest)
	if unsigned.Code != http.StatusUnauthorized || dispatcher.acknowledged {
		t.Fatalf("unsigned callback reached domain: status=%d body=%s", unsigned.Code, unsigned.Body.String())
	}

	headers, err := protocol.Sign(protocol.SignRequest{Method: http.MethodPost, Path: path, Body: body}, secret, protocol.CallTypeProduction)
	if err != nil {
		t.Fatal(err)
	}
	signedRequest := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	signedRequest.Header.Set(protocol.HeaderProtocolVersion, headers.ProtocolVersion)
	signedRequest.Header.Set(protocol.HeaderTimestamp, headers.Timestamp)
	signedRequest.Header.Set(protocol.HeaderNonce, headers.Nonce)
	signedRequest.Header.Set(protocol.HeaderSignature, headers.Signature)
	signedRequest.Header.Set(protocol.HeaderCallType, string(headers.CallType))
	signed := httptest.NewRecorder()
	server.Handler().ServeHTTP(signed, signedRequest)
	if signed.Code != http.StatusOK || !dispatcher.acknowledged {
		t.Fatalf("valid callback rejected: status=%d body=%s", signed.Code, signed.Body.String())
	}
	var assignment struct {
		Status domain.AssignmentStatus `json:"status"`
	}
	if err = json.Unmarshal(signed.Body.Bytes(), &assignment); err != nil || assignment.Status != domain.AssignmentAccepted {
		t.Fatalf("invalid callback response: assignment=%+v err=%v", assignment, err)
	}
}

func TestExecutionCallbackIsVerifiedBeforeForwardingExactBody(t *testing.T) {
	const secret = "agent-signing-secret"
	proxy := &fakeExecutionProxy{}
	verifier := &protocol.Verifier{Keys: fixedKeys{secret: secret}, Nonces: &memoryNonces{used: map[string]bool{}}}
	server := Server{Verifier: verifier, ExecutionProxy: proxy}
	body := []byte(`{"agentId":"agent-1","assignmentId":"assignment-1","progress":40,"reportedAt":"2026-08-23T00:00:00Z"}`)
	path := "/agent-callback/tasks/task-1/status"

	unsignedRequest := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	unsignedRequest.Header.Set("Idempotency-Key", "status:task-1:request-123")
	unsignedRequest.Header.Set(protocol.HeaderProtocolVersion, protocol.ProtocolVersion)
	unsigned := httptest.NewRecorder()
	server.Handler().ServeHTTP(unsigned, unsignedRequest)
	if unsigned.Code != http.StatusUnauthorized || proxy.called {
		t.Fatalf("unsigned execution callback was forwarded: status=%d", unsigned.Code)
	}

	headers, err := protocol.Sign(protocol.SignRequest{Method: http.MethodPost, Path: path, Body: body}, secret, protocol.CallTypeProduction)
	if err != nil {
		t.Fatal(err)
	}
	signedRequest := httptest.NewRequest(http.MethodPost, path, strings.NewReader(string(body)))
	signedRequest.Header.Set("Idempotency-Key", "status:task-1:request-123")
	signedRequest.Header.Set(protocol.HeaderProtocolVersion, headers.ProtocolVersion)
	signedRequest.Header.Set(protocol.HeaderTimestamp, headers.Timestamp)
	signedRequest.Header.Set(protocol.HeaderNonce, headers.Nonce)
	signedRequest.Header.Set(protocol.HeaderSignature, headers.Signature)
	signedRequest.Header.Set(protocol.HeaderCallType, string(headers.CallType))
	signed := httptest.NewRecorder()
	server.Handler().ServeHTTP(signed, signedRequest)
	if signed.Code != http.StatusOK || !proxy.called || proxy.key != "status:task-1:request-123" || string(proxy.body) != string(body) {
		t.Fatalf("verified callback proxy mismatch: status=%d called=%v key=%s", signed.Code, proxy.called, proxy.key)
	}
}
