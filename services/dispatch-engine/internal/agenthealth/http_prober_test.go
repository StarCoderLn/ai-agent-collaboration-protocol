package agenthealth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/domain"
	"github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine/internal/protocol"
)

func TestHTTPProberSignsHealthRequestAndClassifiesSuccess(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/healthz" || request.Method != http.MethodGet {
			t.Fatalf("unexpected health request: %s %s", request.Method, request.URL.Path)
		}
		for _, header := range []string{
			protocol.HeaderProtocolVersion, protocol.HeaderTimestamp, protocol.HeaderNonce,
			protocol.HeaderSignature, protocol.HeaderCallType,
		} {
			if request.Header.Get(header) == "" {
				t.Fatalf("signed health request omitted %s", header)
			}
		}
		return healthResponse(http.StatusOK, `{"status":"up"}`), nil
	})}

	observation := (&HTTPProber{Client: client}).Probe(
		context.Background(), "agent-1", "https://agent.example/v1/tasks?ignored=true", "test-secret", "aicp_hmac",
	)
	if observation.Result != domain.ProbeSuccess || observation.ResultCode != "HEALTH_OK" {
		t.Fatalf("unexpected success observation: %+v", observation)
	}
}

func TestHTTPProberPreservesProtocolErrorCategory(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return healthResponse(
			http.StatusUnauthorized,
			`{"error_code":"AUTH_EXPIRED_TIMESTAMP","message":"expired","retryable":false}`,
		), nil
	})}

	observation := (&HTTPProber{Client: client}).Probe(context.Background(), "agent-1", "https://agent.example", "test-secret", "aicp_hmac")
	if observation.Result != domain.ProbeAuthFailure || observation.ResultCode != string(protocol.ErrCodeAuthExpiredTimestamp) {
		t.Fatalf("unexpected auth observation: %+v", observation)
	}
}

func TestHTTPProberClassifiesTransportTimeout(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return nil, errors.New("dial timeout")
	})}

	observation := (&HTTPProber{Client: client}).Probe(context.Background(), "agent-1", "https://agent.example", "test-secret", "aicp_hmac")
	if observation.Result != domain.ProbeConnectionTimeout || observation.ResultCode != string(protocol.ErrCodeConnTimeout) {
		t.Fatalf("unexpected timeout observation: %+v", observation)
	}
}

func TestHTTPProberChecksPublicQuickAgentWithoutProtocolSignature(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/healthz" || request.Header.Get(protocol.HeaderSignature) != "" || request.Header.Get("Authorization") != "" {
			t.Fatalf("unexpected public quick health request: url=%s headers=%v", request.URL, request.Header)
		}
		return healthResponse(http.StatusOK, `{"status":"ok"}`), nil
	})}

	observation := (&HTTPProber{Client: client}).Probe(
		context.Background(), "agent-1", "https://agent.example/run", "", "http_json",
	)
	if observation.Result != domain.ProbeSuccess || observation.ResultCode != "HEALTH_OK" {
		t.Fatalf("unexpected quick health observation: %+v", observation)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func healthResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
