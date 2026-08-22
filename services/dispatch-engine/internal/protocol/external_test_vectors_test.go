package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestExternalSignatureVector(t *testing.T) {
	type signatureVector struct {
		Secret    string   `json:"secret"`
		Method    string   `json:"method"`
		Path      string   `json:"path"`
		Timestamp string   `json:"timestamp"`
		Nonce     string   `json:"nonce"`
		CallType  CallType `json:"call_type"`
		Body      string   `json:"body"`
		Signature string   `json:"signature"`
	}

	_, currentFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve current test file")
	}
	vectorPath := filepath.Join(filepath.Dir(currentFile), "..", "..", "..", "..", "docs", "protocol-test-vectors", "signature-v1.json")
	contents, err := os.ReadFile(vectorPath)
	if err != nil {
		t.Fatalf("read external signature vector: %v", err)
	}
	var vector signatureVector
	if err := json.Unmarshal(contents, &vector); err != nil {
		t.Fatalf("decode external signature vector: %v", err)
	}

	base := buildSignatureBase(vector.Method, vector.Path, vector.Timestamp, vector.Nonce, vector.CallType, []byte(vector.Body))
	if actual := computeHMACSignature(vector.Secret, base); actual != vector.Signature {
		t.Fatalf("signature mismatch: want %s, got %s", vector.Signature, actual)
	}
}
