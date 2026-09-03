package quickagent

import "testing"

func TestParseResponseAcceptsMinimumContractAndIgnoresExtensions(t *testing.T) {
	artifacts, err := ParseResponse([]byte(`{
		"status":"completed",
		"traceId":"provider-extension",
		"artifacts":[{"type":"document","summary":"交付","content":"# 文档","extra":true}]
	}`))
	if err != nil || len(artifacts) != 1 || artifacts[0].Type != "document" {
		t.Fatalf("valid quick response was rejected: artifacts=%+v err=%v", artifacts, err)
	}
}

func TestParseResponseRejectsUnsupportedOrAmbiguousPayload(t *testing.T) {
	for _, body := range []string{
		`{"status":"queued","artifacts":[{"type":"document","summary":"交付","content":"ok"}]}`,
		`{"status":"completed","artifacts":[{"type":"binary","summary":"交付","content":"ok"}]}`,
		`{"status":"completed","artifacts":[]}`,
		`{"status":"completed","artifacts":[{"type":"document","summary":"","content":"ok"}]}`,
		`{"status":"completed","artifacts":[{"type":"document","summary":"交付","content":"ok"}]} {}`,
	} {
		if _, err := ParseResponse([]byte(body)); err == nil {
			t.Fatalf("invalid quick response was accepted: %s", body)
		}
	}
}
