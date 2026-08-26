package tasktransition

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) { return fn(request) }

func TestHTTPSenderUsesServiceAuthAndPreservesRetryability(t *testing.T) {
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/api/internal/tasks/task-1/transitions" || request.Header.Get("Authorization") != "Bearer secret" {
			t.Fatalf("unexpected request: path=%s authorization=%s", request.URL.Path, request.Header.Get("Authorization"))
		}
		return &http.Response{
			StatusCode: http.StatusConflict,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(`{"error_code":"TRANSITION_NOT_READY","retryable":true}`)),
			Request:    request,
		}, nil
	})}

	err := (&HTTPSender{BaseURL: "http://business-api.local", Token: "secret", Client: client}).Send(context.Background(), Event{
		ID: "event-1", TaskID: "task-1", AssignmentID: "assignment-1", EventType: "agent_accepted",
	})
	var delivery *DeliveryError
	if !errors.As(err, &delivery) || delivery.Code != "TRANSITION_NOT_READY" || !delivery.Retryable {
		t.Fatalf("response classification mismatch: %v", err)
	}
}
