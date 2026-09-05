package httpapi

import (
	"context"
	"encoding/json"
	"errors"
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
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/sandboxadmission"
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

// fakeAdmissionRetry 记录经过内部认证和提供者身份校验后的重新验证命令。错误由测试用例
// 注入，用于证明 HTTP 边界不会把越权或非法状态误报为普通服务异常。
type fakeAdmissionRetry struct {
	agentID, actorID, idempotencyKey string
	err                              error
}

func (f *fakeAdmissionRetry) RetryRound(
	_ context.Context, agentID, actorID, idempotencyKey string, _ time.Time,
) (sandboxadmission.RoundClaim, error) {
	f.agentID, f.actorID, f.idempotencyKey = agentID, actorID, idempotencyKey
	if f.err != nil {
		return sandboxadmission.RoundClaim{}, f.err
	}
	return sandboxadmission.RoundClaim{
		AgentID: agentID, RoundID: "83200000-0000-4000-8000-000000000001", AttemptNo: 2,
	}, nil
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

func TestAgentAdmissionRetryRequiresInternalAuthProviderAndIdempotency(t *testing.T) {
	retry := &fakeAdmissionRetry{}
	server := Server{InternalToken: "internal-secret", AdmissionRetry: retry}
	path := "/internal/agents/83100000-0000-4000-8000-000000000001/admission/retry"

	testCases := []struct {
		name       string
		authorize  bool
		actorID    string
		actorType  string
		requestKey string
		wantStatus int
	}{
		{name: "缺少内部服务凭证", actorID: "provider-1", actorType: "provider", requestKey: "retry:request-1", wantStatus: http.StatusUnauthorized},
		{name: "非提供者身份", authorize: true, actorID: "admin-1", actorType: "admin", requestKey: "retry:request-2", wantStatus: http.StatusForbidden},
		{name: "缺少幂等键", authorize: true, actorID: "provider-1", actorType: "provider", wantStatus: http.StatusBadRequest},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, path, nil)
			if testCase.authorize {
				request.Header.Set("Authorization", "Bearer internal-secret")
			}
			request.Header.Set(headerInternalActor, testCase.actorID)
			request.Header.Set(headerInternalActorType, testCase.actorType)
			request.Header.Set("Idempotency-Key", testCase.requestKey)
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != testCase.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", response.Code, testCase.wantStatus, response.Body.String())
			}
		})
	}
	if retry.agentID != "" {
		t.Fatalf("非法请求不应到达准入仓储：%+v", retry)
	}
}

func TestAgentAdmissionRetryMapsOwnershipStateAndSuccess(t *testing.T) {
	path := "/internal/agents/83100000-0000-4000-8000-000000000001/admission/retry"
	testCases := []struct {
		name       string
		retryError error
		wantStatus int
	}{
		{name: "越权", retryError: sandboxadmission.ErrAdmissionForbidden, wantStatus: http.StatusForbidden},
		{name: "当前状态不可重试", retryError: sandboxadmission.ErrAdmissionNotRetryable, wantStatus: http.StatusConflict},
		{name: "重试超过频率限制", retryError: sandboxadmission.ErrAdmissionRateLimited, wantStatus: http.StatusTooManyRequests},
		{name: "重新排队成功", wantStatus: http.StatusAccepted},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			retry := &fakeAdmissionRetry{err: testCase.retryError}
			server := Server{InternalToken: "internal-secret", AdmissionRetry: retry}
			request := httptest.NewRequest(http.MethodPost, path, nil)
			request.Header.Set("Authorization", "Bearer internal-secret")
			request.Header.Set(headerInternalActor, "provider-1")
			request.Header.Set(headerInternalActorType, "provider")
			request.Header.Set("Idempotency-Key", "retry:request-3")
			response := httptest.NewRecorder()
			server.Handler().ServeHTTP(response, request)
			if response.Code != testCase.wantStatus {
				t.Fatalf("status=%d want=%d body=%s", response.Code, testCase.wantStatus, response.Body.String())
			}
			if retry.agentID != "83100000-0000-4000-8000-000000000001" || retry.actorID != "provider-1" || retry.idempotencyKey != "retry:request-3" {
				t.Fatalf("重新验证命令丢失可信身份或幂等信息：%+v", retry)
			}
			if testCase.retryError == nil && !strings.Contains(response.Body.String(), `"status":"queued"`) {
				t.Fatalf("成功响应没有明确排队状态：%s", response.Body.String())
			}
		})
	}

	// 未知仓储错误必须保留为可重试的 500，不能被错误降级为业务拒绝。
	retry := &fakeAdmissionRetry{err: errors.New("database unavailable")}
	server := Server{InternalToken: "internal-secret", AdmissionRetry: retry}
	request := httptest.NewRequest(http.MethodPost, path, nil)
	request.Header.Set("Authorization", "Bearer internal-secret")
	request.Header.Set(headerInternalActor, "provider-1")
	request.Header.Set(headerInternalActorType, "provider")
	request.Header.Set("Idempotency-Key", "retry:request-4")
	response := httptest.NewRecorder()
	server.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusInternalServerError || !strings.Contains(response.Body.String(), `"retryable":true`) {
		t.Fatalf("未知故障的恢复语义不正确：status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestInternalAgentLifecycleRejectsFormerManualReviewEvents(t *testing.T) {
	for _, testCase := range []struct {
		body       string
		wantStatus int
	}{
		{body: `{"event":"admin_approve"}`, wantStatus: http.StatusForbidden},
		{body: `{"event":"admin_approve","reviewReason":"人工通过"}`, wantStatus: http.StatusUnprocessableEntity},
		{body: `{"event":"admin_approve","admissionDecisionId":"forged-decision"}`, wantStatus: http.StatusUnprocessableEntity},
		{body: `{"event":"admin_reject","reviewReason":"人工驳回"}`, wantStatus: http.StatusUnprocessableEntity},
	} {
		lifecycle := &fakeAgentLifecycle{}
		server := Server{InternalToken: "internal-secret", AgentLifecycle: lifecycle}
		request := httptest.NewRequest(http.MethodPost, "/internal/agents/83100000-0000-4000-8000-000000000001/transitions", strings.NewReader(testCase.body))
		request.Header.Set("Authorization", "Bearer internal-secret")
		request.Header.Set(headerInternalActor, "0x1111111111111111111111111111111111111111")
		request.Header.Set(headerInternalActorType, "admin")
		request.Header.Set("Idempotency-Key", "former-review-event")
		response := httptest.NewRecorder()
		server.Handler().ServeHTTP(response, request)
		if response.Code != testCase.wantStatus || lifecycle.command.Event != nil {
			t.Fatalf("旧人工审核事件不应绕过自动准入：status=%d command=%+v body=%s", response.Code, lifecycle.command, response.Body.String())
		}
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
