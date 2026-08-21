package protocol

import (
	"context"
	"encoding/hex"
	"strconv"
	"sync"
	"testing"
	"time"
)

// fakeKeyResolver 是 AgentKeyResolver 的测试替身：agentID -> 有效密钥列表
// （用于模拟凭证轮换期间新旧密钥并行有效的场景）。
type fakeKeyResolver struct {
	keys map[string][]string
}

func (f *fakeKeyResolver) ActiveSigningKeys(_ context.Context, agentID string) ([]string, error) {
	return f.keys[agentID], nil
}

// fakeNonceStore 是 NonceStore 的测试替身，用内存 map 模拟 used_nonces 表
// `nonce` 主键的全局唯一约束语义，仅供单元测试使用，不代表生产实现（生产实现
// 见 T-004/T-005）。
type fakeNonceStore struct {
	mu   sync.Mutex
	used map[string]bool
}

func newFakeNonceStore() *fakeNonceStore {
	return &fakeNonceStore{used: map[string]bool{}}
}

func (f *fakeNonceStore) ReserveNonce(_ context.Context, _ string, nonce string, _ time.Time) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.used[nonce] {
		return false, nil
	}
	f.used[nonce] = true
	return true, nil
}

// signWithTimestamp 复用 sign.go 的 buildSignatureBase/computeHMACSignature，
// 但允许测试注入固定 timestamp（Sign() 内部固定使用 time.Now()，无法用于构造
// 过期/未来时间戳的测试用例）。
func signWithTimestamp(secret, method, path, timestamp, nonce string, callType CallType, body []byte) string {
	base := buildSignatureBase(method, path, timestamp, nonce, callType, body)
	return computeHMACSignature(secret, base)
}

func newTestVerifier(fixedNow time.Time, keys map[string][]string) (*Verifier, *fakeNonceStore) {
	nonces := newFakeNonceStore()
	v := &Verifier{
		Keys:   &fakeKeyResolver{keys: keys},
		Nonces: nonces,
		Now:    func() time.Time { return fixedNow },
	}
	return v, nonces
}

func TestVerifySignature_ValidRequestAccepted(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"
	ts := strconv.FormatInt(now.Unix(), 10)
	body := []byte(`{"foo":"bar"}`)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-1",
		Signature:       signWithTimestamp(secret, "POST", "/v1/callbacks/progress", ts, "nonce-1", CallTypeProduction, body),
		Body:            body,
	}

	result, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr != nil {
		t.Fatalf("expected success, got error: %+v", protoErr)
	}
	if result.AgentID != agentID {
		t.Fatalf("expected AgentID %q, got %q", agentID, result.AgentID)
	}
}

func TestVerifySignature_SignThenVerifyRoundTrip(t *testing.T) {
	// 端到端验证 Sign()（T-002）产出的头部能被 VerifySignature()（T-003）接受，
	// 确认两者共享的签名基串定义没有漂移。
	agentID := "agent-1"
	secret := "secret-key"
	body := []byte(`{"foo":"bar"}`)

	headers, err := Sign(SignRequest{Method: "POST", Path: "/v1/callbacks/progress", Body: body}, secret, CallTypeProduction)
	if err != nil {
		t.Fatalf("Sign failed: %v", err)
	}

	signedAt, err := strconv.ParseInt(headers.Timestamp, 10, 64)
	if err != nil {
		t.Fatalf("parse timestamp: %v", err)
	}

	v, _ := newTestVerifier(time.Unix(signedAt, 0), map[string][]string{agentID: {secret}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       headers.Timestamp,
		Nonce:           headers.Nonce,
		Signature:       headers.Signature,
		Body:            body,
	}

	if _, protoErr := v.VerifySignature(context.Background(), req); protoErr != nil {
		t.Fatalf("expected Sign() output to verify successfully, got %+v", protoErr)
	}
}

func TestVerifySignature_InvalidSignatureRejected(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {"secret-key"}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-1",
		Signature:       hex.EncodeToString([]byte("not-a-real-signature-not-a-real")),
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil {
		t.Fatal("expected error for invalid signature, got nil")
	}
	if protoErr.Code != ErrCodeAuthInvalidSignature {
		t.Fatalf("expected %s, got %s", ErrCodeAuthInvalidSignature, protoErr.Code)
	}
}

func TestVerifySignature_ExpiredTimestampRejected(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	staleTs := strconv.FormatInt(now.Add(-10*time.Minute).Unix(), 10)
	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       staleTs,
		Nonce:           "nonce-1",
		Signature:       signWithTimestamp(secret, "POST", "/v1/callbacks/progress", staleTs, "nonce-1", CallTypeProduction, nil),
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil {
		t.Fatal("expected error for expired timestamp, got nil")
	}
	if protoErr.Code != ErrCodeAuthExpiredTimestamp {
		t.Fatalf("expected %s, got %s", ErrCodeAuthExpiredTimestamp, protoErr.Code)
	}
}

func TestVerifySignature_FutureTimestampBeyondWindowRejected(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	futureTs := strconv.FormatInt(now.Add(10*time.Minute).Unix(), 10)
	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       futureTs,
		Nonce:           "nonce-1",
		Signature:       signWithTimestamp(secret, "POST", "/v1/callbacks/progress", futureTs, "nonce-1", CallTypeProduction, nil),
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil || protoErr.Code != ErrCodeAuthExpiredTimestamp {
		t.Fatalf("expected %s, got %+v", ErrCodeAuthExpiredTimestamp, protoErr)
	}
}

func TestVerifySignature_ReplayedNonceRejected(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-replay",
		Signature:       signWithTimestamp(secret, "POST", "/v1/callbacks/progress", ts, "nonce-replay", CallTypeProduction, nil),
	}

	if _, protoErr := v.VerifySignature(context.Background(), req); protoErr != nil {
		t.Fatalf("expected first request to succeed, got %+v", protoErr)
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil {
		t.Fatal("expected replay to be rejected, got nil")
	}
	if protoErr.Code != ErrCodeAuthReplayedNonce {
		t.Fatalf("expected %s, got %s", ErrCodeAuthReplayedNonce, protoErr.Code)
	}
}

func TestVerifySignature_KeyRotationAcceptsOldAndNewKey(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	oldSecret := "old-secret"
	newSecret := "new-secret"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {newSecret, oldSecret}})

	reqWithOldKey := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-old",
		Signature:       signWithTimestamp(oldSecret, "POST", "/v1/callbacks/progress", ts, "nonce-old", CallTypeProduction, nil),
	}
	if _, protoErr := v.VerifySignature(context.Background(), reqWithOldKey); protoErr != nil {
		t.Fatalf("expected old key to still be accepted during rotation, got %+v", protoErr)
	}

	reqWithNewKey := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-new",
		Signature:       signWithTimestamp(newSecret, "POST", "/v1/callbacks/progress", ts, "nonce-new", CallTypeProduction, nil),
	}
	if _, protoErr := v.VerifySignature(context.Background(), reqWithNewKey); protoErr != nil {
		t.Fatalf("expected new key to be accepted, got %+v", protoErr)
	}
}

func TestVerifySignature_MissingFieldsRejected(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ts := strconv.FormatInt(now.Unix(), 10)
	v, _ := newTestVerifier(now, map[string][]string{"agent-1": {"secret"}})

	cases := []struct {
		name string
		req  SignedRequest
	}{
		{"missing agent id", SignedRequest{ProtocolVersion: ProtocolVersion, Method: "POST", Path: "/p", Timestamp: ts, Nonce: "n", Signature: "s"}},
		{"missing nonce", SignedRequest{ProtocolVersion: ProtocolVersion, AgentID: "agent-1", Method: "POST", Path: "/p", Timestamp: ts, Signature: "s"}},
		{"missing signature", SignedRequest{ProtocolVersion: ProtocolVersion, AgentID: "agent-1", Method: "POST", Path: "/p", Timestamp: ts, Nonce: "n"}},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, protoErr := v.VerifySignature(context.Background(), c.req)
			if protoErr == nil || protoErr.Code != ErrCodeAuthInvalidSignature {
				t.Fatalf("expected %s, got %+v", ErrCodeAuthInvalidSignature, protoErr)
			}
		})
	}
}

func TestVerifySignature_UnknownAgentRejected(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	ts := strconv.FormatInt(now.Unix(), 10)
	v, _ := newTestVerifier(now, map[string][]string{})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         "unknown-agent",
		Method:          "POST",
		Path:            "/p",
		Timestamp:       ts,
		Nonce:           "n",
		Signature:       "deadbeef",
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil || protoErr.Code != ErrCodeAuthInvalidSignature {
		t.Fatalf("expected %s, got %+v", ErrCodeAuthInvalidSignature, protoErr)
	}
}

// --- F-005: X-Protocol-Version 协议版本化 ---

func TestVerifySignature_UnsupportedProtocolVersionRejected(t *testing.T) {
	// design.md F-005：平台需能识别不兼容版本并返回明确错误，而不是静默失败——
	// 即便签名、时间戳、nonce 均合法，不识别的协议版本也必须先被拒绝
	// （ErrCodeProtocolVersionUnsupported），不得落到签名校验逻辑当作当前版本处理。
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	req := SignedRequest{
		ProtocolVersion: "2.0",
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-1",
		Signature:       signWithTimestamp(secret, "POST", "/v1/callbacks/progress", ts, "nonce-1", CallTypeProduction, nil),
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil {
		t.Fatal("expected unsupported protocol version to be rejected")
	}
	if protoErr.Code != ErrCodeProtocolVersionUnsupported {
		t.Fatalf("expected %s, got %s", ErrCodeProtocolVersionUnsupported, protoErr.Code)
	}
	if protoErr.Code.HTTPStatus() != 400 {
		t.Fatalf("expected 400 for PROTOCOL_VERSION_UNSUPPORTED, got %d", protoErr.Code.HTTPStatus())
	}
}

func TestVerifySignature_MissingProtocolVersionRejected(t *testing.T) {
	// 未携带 X-Protocol-Version（空字符串）视同不识别的版本，同样必须被拒绝，
	// 不得默认按当前版本处理。
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	req := SignedRequest{
		AgentID:   agentID,
		Method:    "POST",
		Path:      "/v1/callbacks/progress",
		Timestamp: ts,
		Nonce:     "nonce-1",
		Signature: signWithTimestamp(secret, "POST", "/v1/callbacks/progress", ts, "nonce-1", CallTypeProduction, nil),
		// ProtocolVersion 留空，模拟调用方未透传 X-Protocol-Version 请求头。
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil || protoErr.Code != ErrCodeProtocolVersionUnsupported {
		t.Fatalf("expected %s, got %+v", ErrCodeProtocolVersionUnsupported, protoErr)
	}
}

// --- T-008: X-Call-Type 标记位 ---

func TestVerifySignature_DefaultsCallTypeToProductionWhenAbsent(t *testing.T) {
	// 未声明 X-Call-Type（SignedRequest.CallType 为空）时必须按 CallTypeProduction
	// 重算基串，才能接受 Sign() 在 callType="" 时产出的签名（design.md「默认值为
	// production」，两侧共用 normalizeCallType）。
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-1",
		Signature:       signWithTimestamp(secret, "POST", "/v1/callbacks/progress", ts, "nonce-1", CallTypeProduction, nil),
		// CallType 留空，模拟调用方未透传 X-Call-Type 头部。
	}

	result, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr != nil {
		t.Fatalf("expected success, got error: %+v", protoErr)
	}
	if result.CallType != CallTypeProduction {
		t.Errorf("expected result call type %q, got %q", CallTypeProduction, result.CallType)
	}
}

func TestVerifySignature_AcceptsExplicitSandboxCallType(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-1",
		CallType:        CallTypeSandbox,
		Signature:       signWithTimestamp(secret, "POST", "/v1/callbacks/progress", ts, "nonce-1", CallTypeSandbox, nil),
	}

	result, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr != nil {
		t.Fatalf("expected success, got error: %+v", protoErr)
	}
	if result.CallType != CallTypeSandbox {
		t.Errorf("expected result call type %q, got %q", CallTypeSandbox, result.CallType)
	}
}

func TestVerifySignature_TamperedCallTypeRejected(t *testing.T) {
	// call_type 纳入签名基串（design.md 模块 4），签名后篡改该字段必须使签名失效，
	// 否则中间人可绕过沙箱标记把沙箱调用伪装成正式调用（或反之）。
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-1",
		// 用 sandbox 签名，但把请求上的 CallType 篡改为 production。
		CallType:  CallTypeProduction,
		Signature: signWithTimestamp(secret, "POST", "/v1/callbacks/progress", ts, "nonce-1", CallTypeSandbox, nil),
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil {
		t.Fatal("expected tampered call type to be rejected, got nil")
	}
	if protoErr.Code != ErrCodeAuthInvalidSignature {
		t.Fatalf("expected %s, got %s", ErrCodeAuthInvalidSignature, protoErr.Code)
	}
}

func TestVerifySignature_InvalidCallTypeRejected(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {"secret-key"}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-1",
		CallType:        CallType("bogus"),
		Signature:       "deadbeef",
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil || protoErr.Code != ErrCodeAuthInvalidSignature {
		t.Fatalf("expected %s, got %+v", ErrCodeAuthInvalidSignature, protoErr)
	}
}

func TestProtocolError_ResponseMirrorsCodeAndMessage(t *testing.T) {
	pe := newProtocolError(ErrCodeAuthReplayedNonce, "nonce already used")
	resp := pe.Response()
	if resp.ErrorCode != ErrCodeAuthReplayedNonce {
		t.Fatalf("expected error code %s, got %s", ErrCodeAuthReplayedNonce, resp.ErrorCode)
	}
	if resp.Retryable {
		t.Fatal("AUTH_REPLAYED_NONCE must not be retryable")
	}
}
