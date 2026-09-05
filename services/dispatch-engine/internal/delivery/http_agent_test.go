package delivery

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/dispatch"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

type agentRoundTripFunc func(*http.Request) (*http.Response, error)

func (fn agentRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

type fixedKeys struct{ secret string }

func (k fixedKeys) ActiveSigningKeys(context.Context, string) ([]string, error) {
	return []string{k.secret}, nil
}

type acceptingNonce struct{}

func (acceptingNonce) ReserveNonce(context.Context, string, string, time.Time) (bool, error) {
	return true, nil
}

func TestHTTPAgentCallerSignsTheExactBodyAndHandlesSyncAcceptance(t *testing.T) {
	secret := "agent-shared-secret"
	client := &http.Client{Transport: agentRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatal(err)
		}
		verifier := protocol.Verifier{Keys: fixedKeys{secret: secret}, Nonces: acceptingNonce{}}
		_, protocolError := verifier.VerifySignature(request.Context(), protocol.SignedRequest{
			AgentID: "agent-1", Method: request.Method, Path: request.URL.Path, Body: body,
			ProtocolVersion: request.Header.Get(protocol.HeaderProtocolVersion),
			Timestamp:       request.Header.Get(protocol.HeaderTimestamp), Nonce: request.Header.Get(protocol.HeaderNonce),
			Signature: request.Header.Get(protocol.HeaderSignature), CallType: protocol.CallType(request.Header.Get(protocol.HeaderCallType)),
		})
		if protocolError != nil || request.Header.Get("Idempotency-Key") != "dispatch:task-1:request-1" {
			t.Fatalf("invalid signed request: protocolError=%v headers=%v", protocolError, request.Header)
		}
		return &http.Response{
			StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"accepted":true}`)), Request: request,
		}, nil
	})}
	accepted, err := (&HTTPAgentCaller{Client: client}).Call(context.Background(), dispatch.DispatchMessage{
		AgentID: "agent-1", TaskID: "task-1", IdempotencyKey: "assign:publisher-key", ProtocolRequestID: "request-1",
	}, Target{Endpoint: "https://agent.local/v1/tasks/dispatch", Secret: secret, Body: []byte(`{"task":{"id":"task-1"}}`)})
	if err != nil || accepted.Accepted == nil || !*accepted.Accepted {
		t.Fatalf("synchronous acceptance mismatch: result=%+v err=%v", accepted, err)
	}
}

func TestHTTPAgentCallerRequiresStableDownstreamIdempotencyIdentifiers(t *testing.T) {
	caller := &HTTPAgentCaller{Client: &http.Client{Transport: agentRoundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("an incomplete message must fail before making an HTTP request")
		return nil, nil
	})}}
	_, err := caller.Call(context.Background(), dispatch.DispatchMessage{IdempotencyKey: "assign:publisher-key"}, Target{
		Endpoint: "https://agent.local/v1/tasks/dispatch",
		Secret:   "agent-shared-secret",
		Body:     []byte(`{"task":{}}`),
	})
	if err == nil || err.Error() != "agent call message is incomplete" {
		t.Fatalf("expected incomplete message error, got %v", err)
	}
}

func TestHTTPAgentCallerTreats202AsAsynchronousQueueAcceptance(t *testing.T) {
	client := &http.Client{Transport: agentRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusAccepted,
			Header:     make(http.Header),
			// 旧版 Agent 会返回这一含义模糊的正文；HTTP 状态码仍是权威信号。
			Body:    io.NopCloser(strings.NewReader(`{"accepted":true}`)),
			Request: request,
		}, nil
	})}
	result, err := (&HTTPAgentCaller{Client: client}).Call(context.Background(), dispatch.DispatchMessage{
		TaskID: "task-1", ProtocolRequestID: "request-1", IdempotencyKey: "assign:publisher-key",
	}, Target{Endpoint: "https://agent.local/v1/tasks/dispatch", Secret: "agent-shared-secret", Body: []byte(`{"task":{}}`)})
	if err != nil || result.Accepted != nil {
		t.Fatalf("202 must wait for the signed asynchronous callback: result=%+v err=%v", result, err)
	}
}

func TestHTTPAgentCallerAcceptsQuickAgentWithoutSDKOrSharedSecret(t *testing.T) {
	client := &http.Client{Transport: agentRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get(protocol.HeaderSignature) != "" || request.Header.Get("Authorization") != "" {
			t.Fatalf("a public quick Agent must not receive invented authentication headers: %v", request.Header)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{
				"status":"completed",
				"artifacts":[{"type":"document","summary":"PRD 交付","content":"# PRD"}]
			}`)),
			Request: request,
		}, nil
	})}
	result, err := (&HTTPAgentCaller{Client: client}).Call(context.Background(), dispatch.DispatchMessage{
		AgentID:           "11111111-1111-4111-8111-111111111111",
		AssignmentID:      "22222222-2222-4222-8222-222222222222",
		TaskID:            "33333333-3333-4333-8333-333333333333",
		ProtocolRequestID: "request-1",
	}, Target{
		Endpoint: "https://agent.local/run", IntegrationMode: "http_json",
		Body: []byte(`{"task":{"title":"整理需求"}}`),
	})
	if err != nil || result.Accepted == nil || !*result.Accepted || len(result.QuickResultPayload) == 0 {
		t.Fatalf("quick result mismatch: result=%+v err=%v", result, err)
	}
	payload := string(result.QuickResultPayload)
	if !strings.Contains(payload, `"mimeType":"text/markdown"`) ||
		!strings.Contains(payload, `"content":"# PRD"`) ||
		!strings.Contains(payload, `"assignmentId":"22222222-2222-4222-8222-222222222222"`) {
		t.Fatalf("quick result was not mapped to the internal artifact contract: %s", payload)
	}
}

func TestHTTPAgentCallerUsesOptionalBearerTokenForQuickAgent(t *testing.T) {
	client := &http.Client{Transport: agentRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "Bearer provider-token" || request.Header.Get(protocol.HeaderSignature) != "" {
			t.Fatalf("quick Agent authentication mismatch: %v", request.Header)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{"status":"completed","artifacts":[{"type":"website","summary":"预览","content":"https://example.com/preview"}]}`)), Request: request}, nil
	})}
	_, err := (&HTTPAgentCaller{Client: client}).Call(context.Background(), dispatch.DispatchMessage{
		AgentID: "11111111-1111-4111-8111-111111111111", AssignmentID: "22222222-2222-4222-8222-222222222222",
		TaskID: "33333333-3333-4333-8333-333333333333", ProtocolRequestID: "request-2",
	}, Target{Endpoint: "https://agent.local/run", IntegrationMode: "http_json", Secret: "provider-token", Body: []byte(`{"task":{}}`)})
	if err != nil {
		t.Fatal(err)
	}
}

func TestHTTPAgentCallerMapsRemoteDocumentToDownloadableFile(t *testing.T) {
	client := &http.Client{Transport: agentRoundTripFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body: io.NopCloser(strings.NewReader(`{
				"status":"completed",
				"artifacts":[{
					"type":"document",
					"summary":"可编辑演示文稿",
					"content":"https://agent.example/artifacts/growth-deck.pptx",
					"mimeType":"application/vnd.openxmlformats-officedocument.presentationml.presentation",
					"sizeBytes":"4096"
				}]
			}`)),
			Request: request,
		}, nil
	})}
	result, err := (&HTTPAgentCaller{Client: client}).Call(context.Background(), dispatch.DispatchMessage{
		AgentID: "11111111-1111-4111-8111-111111111111", AssignmentID: "22222222-2222-4222-8222-222222222222",
		TaskID: "33333333-3333-4333-8333-333333333333", ProtocolRequestID: "request-ppt",
	}, Target{Endpoint: "https://agent.example/run", IntegrationMode: "http_json", Body: []byte(`{"task":{}}`)})
	if err != nil {
		t.Fatal(err)
	}
	payload := string(result.QuickResultPayload)
	if !strings.Contains(payload, `"kind":"file"`) ||
		!strings.Contains(payload, `"storageRef":"https://agent.example/artifacts/growth-deck.pptx"`) ||
		!strings.Contains(payload, `"sizeBytes":"4096"`) {
		t.Fatalf("remote document was not mapped to a downloadable file: %s", payload)
	}
}
