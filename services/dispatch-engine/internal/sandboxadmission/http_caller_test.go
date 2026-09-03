package sandboxadmission

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return f(request) }

func TestHTTPCallerSignsSandboxRequestAndRecordsTechnicalMetrics(t *testing.T) {
	secret := "sandbox-secret"
	body := []byte(`{"request":"test"}`)
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		protocolError := verifyOutboundSandboxRequest(request, secret, body)
		if protocolError != nil {
			t.Fatal(protocolError)
		}
		if request.Header.Get("Idempotency-Key") != "sandbox:"+testRoundID+":1" {
			t.Fatalf("unexpected idempotency key: %s", request.Header.Get("Idempotency-Key"))
		}
		return response(request, 200, `{"result":{"ok":true}}`), nil
	})}
	times := []time.Time{time.Unix(100, 0), time.Unix(100, int64(37*time.Millisecond))}
	caller := HTTPCaller{Client: client, Now: func() time.Time { value := times[0]; times = times[1:]; return value }}
	outcome, err := caller.Call(context.Background(), CallRequest{
		AgentID: testAgentID, RoundID: testRoundID, RunNo: 1, Endpoint: "https://agent.example/v1/run",
		Secret: secret, Body: body, IdempotencyKey: "sandbox:" + testRoundID + ":1",
	})
	if err != nil || !outcome.Succeeded || outcome.OutputRef == nil {
		t.Fatalf("valid sandbox response failed: outcome=%+v err=%v", outcome, err)
	}
	if !outcome.Metrics.ProtocolCompliant || outcome.Metrics.LatencyMS != 37 || outcome.Metrics.HTTPStatus == nil || *outcome.Metrics.HTTPStatus != 200 || outcome.Metrics.ResponseBytes == 0 {
		t.Fatalf("technical metrics mismatch: %+v", outcome.Metrics)
	}
}

func TestHTTPCallerClassifiesProtocolErrorAndMalformedSuccess(t *testing.T) {
	for name, testCase := range map[string]struct {
		status    int
		body      string
		compliant bool
		category  string
	}{
		"standard error":    {502, `{"error_code":"AGENT_INTERNAL_ERROR","message":"failed","retryable":true}`, true, "AGENT_INTERNAL_ERROR"},
		"malformed success": {200, `not-json`, false, "AGENT_INTERNAL_ERROR"},
	} {
		t.Run(name, func(t *testing.T) {
			caller := HTTPCaller{Client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				return response(request, testCase.status, testCase.body), nil
			})}}
			outcome, err := caller.Call(context.Background(), baseCallRequest())
			if err != nil || outcome.Succeeded || outcome.Metrics.ProtocolCompliant != testCase.compliant || outcome.Metrics.ErrorCategory == nil || *outcome.Metrics.ErrorCategory != testCase.category {
				t.Fatalf("unexpected classification: outcome=%+v err=%v", outcome, err)
			}
		})
	}
}

func TestHTTPCallerUsesFormalQuickAgentShapeDuringSandboxAdmission(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("Authorization") != "Bearer provider-token" || request.Header.Get(protocol.HeaderSignature) != "" {
			t.Fatalf("quick sandbox authentication mismatch: %v", request.Header)
		}
		var body struct {
			Task struct {
				Request string `json:"request"`
			} `json:"task"`
			UpstreamArtifacts []any `json:"upstreamArtifacts"`
		}
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil || body.Task.Request != "test" || body.UpstreamArtifacts == nil {
			t.Fatalf("quick sandbox body does not match formal dispatch shape: body=%+v err=%v", body, err)
		}
		return response(request, 200, `{
			"status":"completed",
			"artifacts":[{"type":"document","summary":"测试交付","content":"done"}]
		}`), nil
	})}
	request := baseCallRequest()
	request.IntegrationMode = "http_json"
	request.Secret = "provider-token"

	caller := HTTPCaller{Client: client}
	outcome, err := caller.Call(context.Background(), request)
	if err != nil || !outcome.Succeeded || !outcome.Metrics.ProtocolCompliant {
		t.Fatalf("valid quick sandbox call failed: outcome=%+v err=%v", outcome, err)
	}
}

func TestHTTPCallerRejectsGenericJSONFromQuickAgent(t *testing.T) {
	caller := HTTPCaller{Client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return response(request, 200, `{"result":{"ok":true}}`), nil
	})}}
	request := baseCallRequest()
	request.IntegrationMode = "http_json"
	request.Secret = ""

	outcome, err := caller.Call(context.Background(), request)
	if err != nil || outcome.Succeeded || outcome.Metrics.ProtocolCompliant {
		t.Fatalf("non-contract quick result must fail admission: outcome=%+v err=%v", outcome, err)
	}
}

func TestHTTPCallerRecordsConnectionTimeoutWithoutInventingOutput(t *testing.T) {
	caller := HTTPCaller{Client: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("dial timeout")
	})}}
	outcome, err := caller.Call(context.Background(), baseCallRequest())
	if err != nil || outcome.OutputRef != nil || outcome.Metrics.ErrorCategory == nil || *outcome.Metrics.ErrorCategory != string(protocol.ErrCodeConnTimeout) {
		t.Fatalf("timeout classification mismatch: outcome=%+v err=%v", outcome, err)
	}
}

func TestHTTPCallerRejectsOversizedAgentOutputWithoutPersistingIt(t *testing.T) {
	oversized := strings.Repeat("x", maxSandboxResponseBytes+1)
	caller := HTTPCaller{Client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return response(request, 200, oversized), nil
	})}}
	outcome, err := caller.Call(context.Background(), baseCallRequest())
	if err != nil || outcome.Succeeded || outcome.OutputRef != nil {
		t.Fatalf("oversized output must be a bounded technical failure: outcome=%+v err=%v", outcome, err)
	}
	if outcome.Metrics.ProtocolCompliant || outcome.Metrics.ResponseBytes != maxSandboxResponseBytes+1 {
		t.Fatalf("oversized response metrics mismatch: %+v", outcome.Metrics)
	}
}

func TestHTTPCallerDoesNotTurnCallerCancellationIntoAgentFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	caller := HTTPCaller{Client: &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		return nil, request.Context().Err()
	})}}
	if _, err := caller.Call(ctx, baseCallRequest()); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected caller cancellation, got %v", err)
	}
}

func verifyOutboundSandboxRequest(request *http.Request, secret string, body []byte) error {
	readBody, err := io.ReadAll(request.Body)
	if err != nil || string(readBody) != string(body) {
		return errors.New("sandbox request body changed after signing")
	}
	verifier := protocol.Verifier{
		Keys: staticKeys{secret: secret}, Nonces: memoryNonces{},
		Now: func() time.Time { return time.Unix(parseTimestamp(request.Header.Get(protocol.HeaderTimestamp)), 0) },
	}
	result, protocolError := verifier.VerifySignature(context.Background(), protocol.SignedRequest{
		AgentID: testAgentID, Method: request.Method, Path: request.URL.Path, Body: readBody,
		ProtocolVersion: request.Header.Get(protocol.HeaderProtocolVersion), Timestamp: request.Header.Get(protocol.HeaderTimestamp),
		Nonce: request.Header.Get(protocol.HeaderNonce), Signature: request.Header.Get(protocol.HeaderSignature),
		CallType: protocol.CallType(request.Header.Get(protocol.HeaderCallType)),
	})
	if protocolError != nil {
		return protocolError
	}
	if result.CallType != protocol.CallTypeSandbox {
		return errors.New("sandbox call type was not signed")
	}
	return nil
}

type staticKeys struct{ secret string }

func (s staticKeys) ActiveSigningKeys(context.Context, string) ([]string, error) {
	return []string{s.secret}, nil
}

type memoryNonces struct{}

func (memoryNonces) ReserveNonce(context.Context, string, string, time.Time) (bool, error) {
	return true, nil
}

func parseTimestamp(value string) int64 {
	parsed, _ := strconv.ParseInt(value, 10, 64)
	return parsed
}

func response(request *http.Request, status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json; charset=utf-8"}},
		Body: io.NopCloser(strings.NewReader(body)), Request: request,
	}
}

func baseCallRequest() CallRequest {
	return CallRequest{
		AgentID: testAgentID, RoundID: testRoundID, RunNo: 1, Endpoint: "https://agent.example/v1/run",
		Secret: "sandbox-secret", Body: []byte(`{"request":"test"}`), IdempotencyKey: "sandbox:" + testRoundID + ":1",
	}
}
