package protocol

import "testing"

func TestSign_ProducesExpectedHeaderShape(t *testing.T) {
	req := SignRequest{Method: "POST", Path: "/v1/tasks/123/dispatch", Body: []byte(`{"taskId":"123"}`)}

	headers, err := Sign(req, "test-secret", CallTypeProduction)
	if err != nil {
		t.Fatalf("Sign returned unexpected error: %v", err)
	}

	if headers.ProtocolVersion != ProtocolVersion {
		t.Errorf("expected protocol version %q, got %q", ProtocolVersion, headers.ProtocolVersion)
	}
	if headers.Timestamp == "" {
		t.Error("expected non-empty timestamp")
	}
	if headers.Nonce == "" {
		t.Error("expected non-empty nonce")
	}
	if headers.Signature == "" {
		t.Error("expected non-empty signature")
	}
	if headers.CallType != CallTypeProduction {
		t.Errorf("expected call type %q, got %q", CallTypeProduction, headers.CallType)
	}
}

func TestSign_DifferentNoncesPerCall(t *testing.T) {
	req := SignRequest{Method: "POST", Path: "/v1/tasks/123/dispatch", Body: []byte("{}")}

	first, err := Sign(req, "test-secret", CallTypeProduction)
	if err != nil {
		t.Fatalf("Sign returned unexpected error: %v", err)
	}
	second, err := Sign(req, "test-secret", CallTypeProduction)
	if err != nil {
		t.Fatalf("Sign returned unexpected error: %v", err)
	}

	if first.Nonce == second.Nonce {
		t.Error("expected distinct nonces across separate Sign calls")
	}
	// Nonce 参与签名基串计算，两次调用 nonce 不同，签名理应不同，即使 timestamp 相同。
	if first.Signature == second.Signature {
		t.Error("expected distinct signatures when nonces differ")
	}
}

func TestSign_DeterministicForFixedInputs(t *testing.T) {
	// buildSignatureBase 与 computeHMACSignature 对相同输入必须产出相同签名，
	// 这是 VerifySignature（T-003）能够重算并比对签名的前提。
	base := buildSignatureBase("POST", "/v1/tasks/123/dispatch", "1700000000", "fixed-nonce", CallTypeProduction, []byte(`{"a":1}`))
	sig1 := computeHMACSignature("test-secret", base)
	sig2 := computeHMACSignature("test-secret", base)

	if sig1 != sig2 {
		t.Errorf("expected deterministic signature for identical inputs, got %q vs %q", sig1, sig2)
	}
	if sig1 == "" {
		t.Error("expected non-empty signature")
	}
}

func TestSign_DifferentSecretsProduceDifferentSignatures(t *testing.T) {
	base := buildSignatureBase("POST", "/v1/tasks/123/dispatch", "1700000000", "fixed-nonce", CallTypeProduction, []byte(`{"a":1}`))

	sigA := computeHMACSignature("secret-a", base)
	sigB := computeHMACSignature("secret-b", base)

	if sigA == sigB {
		t.Error("expected different secrets to produce different signatures")
	}
}

func TestSign_RejectsEmptySecret(t *testing.T) {
	req := SignRequest{Method: "POST", Path: "/v1/tasks/123/dispatch"}

	if _, err := Sign(req, "", CallTypeProduction); err == nil {
		t.Error("expected error when secret is empty")
	}
}

func TestSign_RejectsMissingMethodOrPath(t *testing.T) {
	cases := []SignRequest{
		{Method: "", Path: "/v1/tasks/123/dispatch"},
		{Method: "POST", Path: ""},
	}

	for _, req := range cases {
		if _, err := Sign(req, "test-secret", CallTypeProduction); err == nil {
			t.Errorf("expected error for incomplete request %+v", req)
		}
	}
}

func TestBuildSignatureBase_DisambiguatesAdjacentFields(t *testing.T) {
	// 没有分隔符时 "GET"+"Apath" 与 "GETA"+"path" 会产生相同拼接结果；
	// 分隔符必须消除这种歧义。
	baseA := buildSignatureBase("GET", "Apath", "1700000000", "n", CallTypeProduction, []byte("body"))
	baseB := buildSignatureBase("GETA", "path", "1700000000", "n", CallTypeProduction, []byte("body"))

	if bytesEqual(baseA, baseB) {
		t.Error("expected different signature bases for ambiguous method/path concatenation without separators")
	}
}

// --- T-008: X-Call-Type 标记位 ---

func TestSign_DefaultsCallTypeToProduction(t *testing.T) {
	req := SignRequest{Method: "POST", Path: "/v1/tasks/123/dispatch", Body: []byte("{}")}

	headers, err := Sign(req, "test-secret", "")
	if err != nil {
		t.Fatalf("Sign returned unexpected error: %v", err)
	}
	if headers.CallType != CallTypeProduction {
		t.Errorf("expected empty call type to default to %q, got %q", CallTypeProduction, headers.CallType)
	}
}

func TestSign_RejectsInvalidCallType(t *testing.T) {
	req := SignRequest{Method: "POST", Path: "/v1/tasks/123/dispatch"}

	if _, err := Sign(req, "test-secret", CallType("bogus")); err == nil {
		t.Error("expected error for invalid call type")
	}
}

func TestSign_SandboxAndProductionProduceDifferentSignatures(t *testing.T) {
	req := SignRequest{Method: "POST", Path: "/v1/tasks/123/dispatch", Body: []byte("{}")}

	base := buildSignatureBase(req.Method, req.Path, "1700000000", "fixed-nonce", CallTypeProduction, req.Body)
	sandboxBase := buildSignatureBase(req.Method, req.Path, "1700000000", "fixed-nonce", CallTypeSandbox, req.Body)

	sig := computeHMACSignature("test-secret", base)
	sandboxSig := computeHMACSignature("test-secret", sandboxBase)

	if sig == sandboxSig {
		t.Error("expected sandbox and production call types to produce different signatures")
	}
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
