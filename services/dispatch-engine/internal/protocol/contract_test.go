package protocol

// contract_test.go 是 feature 1（agent-protocol-contract）的契约测试（T-006），
// 对照 requirements.md 的验收标准（AC-001~AC-004、AC-006）逐条验证端到端行为。
//
// 与 sign_test.go / verify_test.go / idempotency_test.go / errors_test.go 中已有
// 的单函数单元测试不同，本文件按「验收标准」而非「实现单元」组织用例，串联
// Sign() → VerifySignature() → Idempotency 的完整调用链，作为第三方 Agent 团队
// 阅读协议规格文档（T-007）之外的可执行契约参照，避免文档描述与实际行为漂移。
// 不重复各函数已被单元测试覆盖的边界分支，只验证 AC 关心的端到端可观察行为。

import (
	"context"
	"strconv"
	"testing"
	"time"
)

// --- AC-001: 使用错误或过期签名调用受保护端点时被拒绝，并返回统一错误码（不是裸 500）---

func TestContract_AC001_InvalidSignatureRejectedWithUnifiedErrorCode(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	ts := strconv.FormatInt(now.Unix(), 10)

	v, _ := newTestVerifier(now, map[string][]string{agentID: {"real-secret"}})

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/progress",
		Timestamp:       ts,
		Nonce:           "nonce-1",
		Signature:       signWithTimestamp("wrong-secret", "POST", "/v1/callbacks/progress", ts, "nonce-1", CallTypeProduction, nil),
	}

	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil {
		t.Fatal("expected forged signature to be rejected")
	}

	resp := protoErr.Response()
	if resp.ErrorCode != ErrCodeAuthInvalidSignature {
		t.Fatalf("expected unified error code %s, got %s", ErrCodeAuthInvalidSignature, resp.ErrorCode)
	}
	if resp.Message == "" {
		t.Error("expected non-empty message, not a bare 500")
	}
	if ErrCodeAuthInvalidSignature.HTTPStatus() != 401 {
		t.Fatalf("expected 401 for AUTH_INVALID_SIGNATURE, got %d", ErrCodeAuthInvalidSignature.HTTPStatus())
	}
}

func TestContract_AC001_ExpiredSignatureRejectedWithUnifiedErrorCode(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	agentID := "agent-1"
	secret := "secret-key"

	v, _ := newTestVerifier(now, map[string][]string{agentID: {secret}})

	staleTs := strconv.FormatInt(now.Add(-1*time.Hour).Unix(), 10)
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
		t.Fatal("expected expired timestamp to be rejected")
	}
	resp := protoErr.Response()
	if resp.ErrorCode != ErrCodeAuthExpiredTimestamp {
		t.Fatalf("expected unified error code %s, got %s", ErrCodeAuthExpiredTimestamp, resp.ErrorCode)
	}
}

// --- AC-002: 相同幂等键的重复请求不会产生重复的派发记录或重复的结果提交 ---

func TestContract_AC002_DuplicateIdempotencyKeyDoesNotReprocess(t *testing.T) {
	r, _ := newTestIdempotency(time.Unix(1_700_000_000, 0))
	ctx := context.Background()
	key := "dispatch:task-1:client-generated-id"

	// 第一次请求：key 未被占用，业务逻辑应当执行一次。
	existing, reserved, err := r.CheckAndReserve(ctx, key, "dispatch", CallTypeProduction)
	if err != nil {
		t.Fatalf("unexpected error on first CheckAndReserve: %v", err)
	}
	if !reserved || existing != nil {
		t.Fatalf("expected first request to be newly reserved with no existing snapshot, got reserved=%v existing=%+v", reserved, existing)
	}

	// 模拟业务逻辑执行完成，落盘响应快照。
	snapshot := ResponseSnapshot{StatusCode: 202, Body: []byte(`{"dispatch_id":"d-1"}`)}
	if err := r.Commit(ctx, key, snapshot); err != nil {
		t.Fatalf("Commit failed: %v", err)
	}

	// 第二次请求：同一幂等键重复到达（如客户端超时重试），必须直接拿到历史响应，
	// 不得重新执行派发逻辑（否则会产生重复派发记录，违反 AC-002）。
	existingAgain, reservedAgain, err := r.CheckAndReserve(ctx, key, "dispatch", CallTypeProduction)
	if err != nil {
		t.Fatalf("unexpected error on duplicate CheckAndReserve: %v", err)
	}
	if reservedAgain {
		t.Fatal("expected duplicate request to be rejected for re-processing, not re-reserved")
	}
	if existingAgain == nil || existingAgain.StatusCode != 202 || string(existingAgain.Body) != `{"dispatch_id":"d-1"}` {
		t.Fatalf("expected duplicate request to receive the original response snapshot, got %+v", existingAgain)
	}
}

// --- AC-003: 认证失败、协议不兼容、连接超时、Agent 内部错误四类场景可通过响应中的错误码明确区分 ---

func TestContract_AC003_FourErrorCategoriesAreDistinguishable(t *testing.T) {
	// 三个 AUTH_* 错误码同属「认证失败」类别，与其余三个类别（协议不兼容/连接超时/
	// Agent 内部错误）分别独立，四类之间互不重叠，且各自的可重试语义符合
	// design.md 模块 3：认证失败与协议不兼容不可重试，连接超时与 Agent 内部错误可重试。
	categories := map[ErrorCode]string{
		ErrCodeAuthInvalidSignature:       "认证失败",
		ErrCodeAuthExpiredTimestamp:       "认证失败",
		ErrCodeAuthReplayedNonce:          "认证失败",
		ErrCodeProtocolVersionUnsupported: "协议不兼容",
		ErrCodeConnTimeout:                "连接超时",
		ErrCodeAgentInternalError:         "Agent 内部错误",
	}

	wantRetryable := map[string]bool{
		"认证失败":       false,
		"协议不兼容":      false,
		"连接超时":       true,
		"Agent 内部错误": true,
	}

	seenCodes := map[ErrorCode]bool{}
	for code, category := range categories {
		if seenCodes[code] {
			t.Fatalf("error code %s must belong to exactly one category", code)
		}
		seenCodes[code] = true

		resp := NewErrorResponse(code, "test message")
		if resp.ErrorCode != code {
			t.Errorf("expected response to echo error code %s, got %s", code, resp.ErrorCode)
		}
		if resp.Retryable != wantRetryable[category] {
			t.Errorf("category %q (code %s): expected retryable=%v, got %v", category, code, wantRetryable[category], resp.Retryable)
		}
	}

	if len(seenCodes) != 6 {
		t.Fatalf("expected all 6 error codes covered across 4 categories, got %d", len(seenCodes))
	}
}

// --- AC-004: 重放同一个（时间戳+nonce）组合的历史请求被拒绝 ---

func TestContract_AC004_ReplayedTimestampNonceCombinationRejected(t *testing.T) {
	agentID := "agent-1"
	secret := "secret-key"

	// Sign() 内部固定使用真实 time.Now()（design.md 未开放注入时钟），因此这里的
	// Verifier 也使用真实时钟（Now 留空，回退到 v.now() 的 time.Now()），而不是像
	// 其他契约用例那样注入固定 now——否则 Sign() 产出的时间戳会落在固定 now 的时间
	// 窗口之外，得到 AUTH_EXPIRED_TIMESTAMP 而非本用例想验证的重放场景。
	v := &Verifier{
		Keys:   &fakeKeyResolver{keys: map[string][]string{agentID: {secret}}},
		Nonces: newFakeNonceStore(),
	}

	// 通过 Sign() 生成一个真实、合法的出站请求（而不是手工拼装签名），确保契约
	// 测试验证的是「平台 Sign 产出的请求头，经历史使用后原样重放会被拒绝」这一
	// 端到端场景，而不只是 VerifySignature 内部的 nonce 存储逻辑。
	headers, err := Sign(SignRequest{Method: "POST", Path: "/v1/tasks/task-1/dispatch", Body: []byte(`{}`)}, secret, CallTypeProduction)
	if err != nil {
		t.Fatalf("Sign failed: %v", err)
	}

	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/tasks/task-1/dispatch",
		Timestamp:       headers.Timestamp,
		Nonce:           headers.Nonce,
		Signature:       headers.Signature,
		Body:            []byte(`{}`),
	}

	if _, protoErr := v.VerifySignature(context.Background(), req); protoErr != nil {
		t.Fatalf("expected first, never-before-seen request to be accepted, got %+v", protoErr)
	}

	// 重放完全相同的历史请求（相同 timestamp + nonce 组合）。
	_, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr == nil {
		t.Fatal("expected replayed request to be rejected")
	}
	if protoErr.Code != ErrCodeAuthReplayedNonce {
		t.Fatalf("expected %s, got %s", ErrCodeAuthReplayedNonce, protoErr.Code)
	}
}

// --- AC-006: 携带 call_type=sandbox 的请求可在审计记录/统计查询中被明确标记和排除 ---

func TestContract_AC006_SandboxCallTypeDefaultsToProductionWhenUnspecified(t *testing.T) {
	// 调用方不显式声明 call_type 时，Sign() 与 VerifySignature() 都必须落到
	// production——遗漏标记不能被误判为沙箱调用（design.md 技术决策：默认值
	// 选择更保守的方向），否则正式任务会被错误地排除出历史统计。
	agentID := "agent-1"
	secret := "secret-key"

	headers, err := Sign(SignRequest{Method: "POST", Path: "/v1/callbacks/health", Body: nil}, secret, "")
	if err != nil {
		t.Fatalf("Sign failed: %v", err)
	}
	if headers.CallType != CallTypeProduction {
		t.Fatalf("expected Sign() to default call type to %q, got %q", CallTypeProduction, headers.CallType)
	}

	// 真实时钟：Sign() 固定使用 time.Now()，Verifier 需要用同源时钟校验时间窗口
	// （见 TestContract_AC004_ReplayedTimestampNonceCombinationRejected 的说明）。
	v := &Verifier{
		Keys:   &fakeKeyResolver{keys: map[string][]string{agentID: {secret}}},
		Nonces: newFakeNonceStore(),
	}
	req := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/health",
		Timestamp:       headers.Timestamp,
		Nonce:           headers.Nonce,
		Signature:       headers.Signature,
		// CallType 留空，模拟调用方未透传 X-Call-Type 请求头。
	}

	result, protoErr := v.VerifySignature(context.Background(), req)
	if protoErr != nil {
		t.Fatalf("expected success, got error: %+v", protoErr)
	}
	if result.CallType != CallTypeProduction {
		t.Fatalf("expected verified call type to default to %q for downstream audit/statistics filtering, got %q", CallTypeProduction, result.CallType)
	}
}

func TestContract_AC006_SandboxCallTypeMustBeExplicitAndSignatureCovered(t *testing.T) {
	agentID := "agent-1"
	secret := "secret-key"

	// 显式声明 sandbox 的沙箱调用应被平台正确识别，供下游审计/统计据此排除。
	headers, err := Sign(SignRequest{Method: "POST", Path: "/v1/callbacks/health", Body: nil}, secret, CallTypeSandbox)
	if err != nil {
		t.Fatalf("Sign failed: %v", err)
	}
	if headers.CallType != CallTypeSandbox {
		t.Fatalf("expected explicit sandbox call type to be preserved, got %q", headers.CallType)
	}

	// 真实时钟：理由同上（Sign() 固定使用 time.Now()）。
	v := &Verifier{
		Keys:   &fakeKeyResolver{keys: map[string][]string{agentID: {secret}}},
		Nonces: newFakeNonceStore(),
	}
	sandboxReq := SignedRequest{
		ProtocolVersion: ProtocolVersion,
		AgentID:         agentID,
		Method:          "POST",
		Path:            "/v1/callbacks/health",
		Timestamp:       headers.Timestamp,
		Nonce:           headers.Nonce,
		Signature:       headers.Signature,
		CallType:        CallTypeSandbox,
	}

	result, protoErr := v.VerifySignature(context.Background(), sandboxReq)
	if protoErr != nil {
		t.Fatalf("expected sandbox call to verify successfully, got %+v", protoErr)
	}
	if result.CallType != CallTypeSandbox {
		t.Fatalf("expected verified call type %q, got %q", CallTypeSandbox, result.CallType)
	}

	// call_type 被签名覆盖：中间人把已签名的 sandbox 请求头部篡改为 production
	// （或反之）来污染正式历史/绕过沙箱标记，必须使签名校验失败。
	tamperedReq := sandboxReq
	tamperedReq.Nonce = "nonce-tamper-attempt" // 换新 nonce 避免命中上一次的 nonce 占用而非签名校验路径
	tamperedReq.CallType = CallTypeProduction

	_, protoErr = v.VerifySignature(context.Background(), tamperedReq)
	if protoErr == nil {
		t.Fatal("expected tampered call_type to invalidate the signature")
	}
	if protoErr.Code != ErrCodeAuthInvalidSignature {
		t.Fatalf("expected %s for tampered call_type, got %s", ErrCodeAuthInvalidSignature, protoErr.Code)
	}
}
