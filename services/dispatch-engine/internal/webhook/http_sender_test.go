package webhook

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/executionproxy"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

type webhookRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn webhookRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type webhookKeys struct{ secret string }

func (k webhookKeys) ActiveSigningKeys(context.Context, string) ([]string, error) {
	return []string{k.secret}, nil
}

type webhookNonceStore struct{}

func (webhookNonceStore) ReserveNonce(context.Context, string, string, time.Time) (bool, error) {
	return true, nil
}

type recordingQuickSubmitter struct {
	taskID, workflowNodeID, operation, idempotencyKey string
	body                                              []byte
}

func (s *recordingQuickSubmitter) Forward(
	_ context.Context,
	taskID, workflowNodeID, operation, idempotencyKey string,
	body []byte,
) (executionproxy.Response, error) {
	s.taskID, s.workflowNodeID, s.operation, s.idempotencyKey = taskID, workflowNodeID, operation, idempotencyKey
	s.body = append([]byte(nil), body...)
	return executionproxy.Response{StatusCode: http.StatusCreated}, nil
}

func TestHTTPSenderPostsStableSignedEventEnvelope(t *testing.T) {
	var received map[string]any
	secret := "0123456789abcdef"
	client := &http.Client{Transport: webhookRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/agent/webhook" || request.Header.Get("Idempotency-Key") != "webhook:task:7:agent" {
			t.Errorf("unexpected request target or idempotency key: %s %s", request.URL.Path, request.Header.Get("Idempotency-Key"))
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		verifier := protocol.Verifier{Keys: webhookKeys{secret: secret}, Nonces: webhookNonceStore{}}
		_, protocolError := verifier.VerifySignature(request.Context(), protocol.SignedRequest{
			AgentID: "agent", Method: request.Method, Path: request.URL.Path, Body: body,
			ProtocolVersion: request.Header.Get(protocol.HeaderProtocolVersion),
			Timestamp:       request.Header.Get(protocol.HeaderTimestamp), Nonce: request.Header.Get(protocol.HeaderNonce),
			Signature: request.Header.Get(protocol.HeaderSignature), CallType: protocol.CallType(request.Header.Get(protocol.HeaderCallType)),
		})
		if protocolError != nil {
			t.Fatalf("webhook signature did not cover exact body: %v", protocolError)
		}
		if err := json.Unmarshal(body, &received); err != nil {
			t.Errorf("decode webhook body: %v", err)
		}
		return &http.Response{
			StatusCode: http.StatusNoContent, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader("")), Request: request,
		}, nil
	})}

	sender := &HTTPSender{Client: client}
	err := sender.Send(context.Background(), Delivery{
		TaskEventID: "7", TaskID: "task", AgentID: "agent",
		Endpoint: "https://agent.local/agent/webhook", IdempotencyKey: "webhook:task:7:agent",
		EventType: "task.agent_accepted", StatusVersion: "3",
		Payload:        []byte(`{"status":"executing"}`),
		EventCreatedAt: time.Date(2026, 8, 23, 1, 2, 3, 456_000_000, time.UTC),
	}, secret)
	if err != nil {
		t.Fatalf("Send returned error: %v", err)
	}
	if received["schemaVersion"] != "task-event.v1" || received["eventId"] != "7" ||
		received["createdAt"] != "2026-08-23T01:02:03.456Z" {
		t.Fatalf("unexpected envelope: %#v", received)
	}
}

func TestHTTPSenderClassifiesHTTPFailures(t *testing.T) {
	for _, test := range []struct {
		name, status string
		code         int
		retryable    bool
	}{
		{name: "rate limit", status: "AGENT_HTTP_429", code: http.StatusTooManyRequests, retryable: true},
		{name: "server error", status: "AGENT_HTTP_503", code: http.StatusServiceUnavailable, retryable: true},
		{name: "invalid request", status: "AGENT_HTTP_400", code: http.StatusBadRequest, retryable: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: webhookRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				return &http.Response{
					StatusCode: test.code, Header: make(http.Header),
					Body: io.NopCloser(strings.NewReader("")), Request: request,
				}, nil
			})}
			err := (&HTTPSender{Client: client}).Send(context.Background(), Delivery{
				Endpoint: "https://agent.local/webhook", Payload: []byte(`{}`), EventCreatedAt: time.Now(),
			}, "0123456789abcdef")
			typed, ok := err.(*DeliveryError)
			if !ok || typed.Code != test.status || typed.Retryable != test.retryable {
				t.Fatalf("unexpected error: %#v", err)
			}
		})
	}
}

func TestHTTPSenderRejectsEndpointCredentialsWithoutNetworkCall(t *testing.T) {
	err := (&HTTPSender{Client: http.DefaultClient}).Send(context.Background(), Delivery{
		Endpoint: "https://user:pass@example.com/webhook", Payload: []byte(`{}`), EventCreatedAt: time.Now(),
	}, "0123456789abcdef")
	typed, ok := err.(*DeliveryError)
	if !ok || typed.Code != "AGENT_WEBHOOK_ENDPOINT_INVALID" || typed.Retryable {
		t.Fatalf("unexpected endpoint validation error: %#v", err)
	}
}

func TestHTTPSenderRunsHTTPJSONReworkAndForwardsQuickResult(t *testing.T) {
	var receivedBody []byte
	client := &http.Client{Transport: webhookRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/run" || request.Header.Get("Idempotency-Key") != "dispatch:task-1:request-1" {
			t.Fatalf("unexpected quick rework request: %s %s", request.URL.Path, request.Header.Get("Idempotency-Key"))
		}
		var err error
		receivedBody, err = io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read quick rework body: %v", err)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(
				`{"status":"completed","artifacts":[{"type":"document","summary":"修订报告","content":"# 新报告"}]}`,
			)),
			Request: request,
		}, nil
	})}
	submitter := &recordingQuickSubmitter{}
	dispatchBody := `{"schemaVersion":"dispatch.v1","requestId":"request-1","assignmentId":"assignment-1","task":{"title":"节点标题"}}`
	payload := `{"workflowNodeId":"node-1","requestId":"request-1","dispatch":` + dispatchBody + `}`
	err := (&HTTPSender{Client: client, Submitter: submitter}).Send(context.Background(), Delivery{
		ID: "delivery-1", TaskID: "task-1", AgentID: "agent-1", Endpoint: "https://agent.local/run",
		IdempotencyKey: "webhook:task-1:1:agent-1", EventType: "task.rework_requested",
		IntegrationMode: "http_json", Payload: []byte(payload),
	}, "")
	if err != nil {
		t.Fatalf("quick rework send failed: %v", err)
	}
	if string(receivedBody) != dispatchBody {
		t.Fatalf("quick Agent did not receive reconstructed dispatch: %s", receivedBody)
	}
	if submitter.taskID != "task-1" || submitter.workflowNodeID != "node-1" ||
		submitter.operation != "results" || submitter.idempotencyKey != "quick-rework-result:task-1:request-1" ||
		!strings.Contains(string(submitter.body), `"assignmentId":"assignment-1"`) {
		t.Fatalf("quick result was not forwarded with stable identifiers: %+v %s", submitter, submitter.body)
	}
}
