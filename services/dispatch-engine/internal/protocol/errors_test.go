package protocol

import (
	"encoding/json"
	"testing"
)

func TestNewErrorResponse_JSONShape(t *testing.T) {
	resp := NewErrorResponse(ErrCodeAuthInvalidSignature, "signature mismatch")

	b, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal error response: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatalf("unmarshal error response: %v", err)
	}

	for _, key := range []string{"error_code", "message", "retryable"} {
		if _, ok := got[key]; !ok {
			t.Errorf("expected key %q in JSON response, got %v", key, got)
		}
	}
}

func TestErrorCode_RetryableClassification(t *testing.T) {
	cases := []struct {
		code      ErrorCode
		retryable bool
	}{
		{ErrCodeAuthInvalidSignature, false},
		{ErrCodeAuthExpiredTimestamp, false},
		{ErrCodeAuthReplayedNonce, false},
		{ErrCodeProtocolVersionUnsupported, false},
		{ErrCodeConnTimeout, true},
		{ErrCodeAgentInternalError, true},
	}

	for _, c := range cases {
		resp := NewErrorResponse(c.code, "test")
		if resp.Retryable != c.retryable {
			t.Errorf("code %s: expected retryable=%v, got %v", c.code, c.retryable, resp.Retryable)
		}
	}
}

func TestProtocolVersionConstant(t *testing.T) {
	if ProtocolVersion == "" {
		t.Fatal("ProtocolVersion must not be empty")
	}
	if HeaderProtocolVersion != "X-Protocol-Version" {
		t.Fatalf("unexpected header name: %s", HeaderProtocolVersion)
	}
}
