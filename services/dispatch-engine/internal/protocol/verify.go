package protocol

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strconv"
	"time"
)

// defaultTimeWindow 是签名时间戳允许的默认偏移窗口（design.md 模块 1：
// 「时间窗口默认 ±5 分钟（可配置）」）。
const defaultTimeWindow = 5 * time.Minute

// SignedRequest 是签名校验所需的最小请求视图，与具体 HTTP 框架解耦——调用方
// （HTTP handler）负责从真实请求中提取 HeaderTimestamp/HeaderNonce/
// HeaderSignature 三个头部并填充本结构，本包不依赖 net/http，避免协议层与
// 传输层耦合（AGENTS.md「优先设计深模块」）。字段含义与 SignRequest（T-002）
// 的 Method/Path/Body 保持一致，二者共用同一套签名基串拼接逻辑
// （buildSignatureBase），不得各自实现。
//
// AgentID 用于解析签名密钥与 nonce 归属，来源由调用方决定（如路由参数或会话
// 上下文）——design.md 未将其列为签名请求头，视为路由/身份层已解析好的输入。
type SignedRequest struct {
	AgentID string
	Method  string
	Path    string
	// ProtocolVersion 对应 HeaderProtocolVersion（X-Protocol-Version），调用方
	// 原样透传 HTTP 请求头的值，不做归一化——不识别的版本号必须被拒绝
	// （ErrCodeProtocolVersionUnsupported），不得静默按当前版本的规则继续解析
	// 后续字段（design.md F-005「协议版本化」：平台需能识别不兼容版本并返回
	// 明确错误，而不是静默失败）。
	ProtocolVersion string
	Timestamp       string // 对应 HeaderTimestamp，十进制 Unix 秒字符串
	Nonce           string // 对应 HeaderNonce
	Signature       string // 对应 HeaderSignature，hex 编码的 HMAC-SHA256
	Body            []byte
	// CallType 对应 HeaderCallType（X-Call-Type，design.md 模块 4 / v2 新增）。
	// 调用方原样透传 HTTP 请求头的值，缺失时传空字符串——VerifySignature 与
	// Sign() 共用 normalizeCallType 将空值归一化为 CallTypeProduction，两侧对
	// "未声明等同 production" 的理解必须保持一致，否则合法请求会因基串不一致
	// 被拒绝。
	CallType CallType
}

// VerifyResult 是验签成功后的结果，供上层中间件继续处理请求（如据此加载
// Agent 上下文）。
type VerifyResult struct {
	AgentID string
	// CallType 是已归一化（空值 -> CallTypeProduction）的沙箱模式标记
	// （design.md 模块 4）。调用方（如 T-005 幂等中间件）应据此写入
	// idempotency_records.call_type 等下游字段，不需要重新解析 X-Call-Type
	// 头部或重新实现一次默认值判断。
	CallType CallType
}

// AgentKeyResolver 解析某个 Agent 当前有效的签名密钥集合。凭证轮换期间新旧
// 密钥应同时返回，VerifySignature 依次尝试直到匹配成功（F-004「凭证轮换期间
// 新旧凭证并行有效」），命中任意一个即视为验签通过。密钥以 string 表示，
// 与 Sign()（T-002）的 secret 参数类型保持一致。
//
// 密钥的加密存储与轮换实现属于 feature 2（Agent 注册），本包只消费、不实现
// 存储（design.md「安全考虑」：签名密钥读取路径与存储路径分离）。
type AgentKeyResolver interface {
	ActiveSigningKeys(ctx context.Context, agentID string) ([]string, error)
}

// NonceStore 记录已使用的 nonce，防止重放（F-004、AC-004）。ReserveNonce 必须
// 是原子的“检查并占用”操作：同一 nonce 只能成功占用一次，并发请求下也不得让
// 两次占用同时成功，否则重放防护失效。
//
// nonce 全局唯一（与 used_nonces 表 `nonce` 为主键、非 (agent_id, nonce) 复合
// 主键的实际约束一致，T-004 migration），agentID 仅用于落库归属与审计，不参与
// 唯一性判定；调用方不应假设不同 Agent 之间可以复用同一个 nonce 值。
//
// 生产实现基于 used_nonces 表（T-004 已建表），本包只依赖该接口，不假设具体
// 存储介质，T-005 落地具体实现时无需改动本文件。
type NonceStore interface {
	ReserveNonce(ctx context.Context, agentID, nonce string, observedAt time.Time) (fresh bool, err error)
}

// Verifier 组合验签所需的依赖，替代把 resolver/store/window 作为裸参数逐个
// 传入 VerifySignature（避免过长参数列表）。TimeWindow 与 Now 为零值时分别
// 回退到 defaultTimeWindow 与 time.Now，Now 主要供测试注入固定时钟。
type Verifier struct {
	Keys       AgentKeyResolver
	Nonces     NonceStore
	TimeWindow time.Duration
	Now        func() time.Time
}

func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

func (v *Verifier) timeWindow() time.Duration {
	if v.TimeWindow > 0 {
		return v.TimeWindow
	}
	return defaultTimeWindow
}

// VerifySignature 校验 Agent 回调平台的请求签名、时间窗口与 nonce 防重放
// （design.md 模块 1、F-001、F-004；AC-001、AC-004）。
//
// 校验顺序固定为：协议版本 → 时间窗口 → 必填字段 → 签名 → nonce 占用，原因：
//  1. 协议版本最先校验：不识别的版本可能意味着请求头语义或签名基串构成已经
//     变化（design.md F-005），继续用当前版本的规则解析后续字段没有意义，
//     必须在触碰任何签名/时间逻辑之前就明确拒绝，而不是静默按当前版本处理；
//  2. 时间窗口其次校验，让明显过期的请求在计算 HMAC 之前就快速失败；
//  3. 签名必须先于 nonce 占用校验通过，未认证的请求不应有能力抢占合法
//     nonce（即便该 nonce 尚未被真正使用），否则会让真实请求之后重放失败。
//
// 返回值遵循 design.md 接口契约 `VerifySignature(req) (VerifyResult, ProtocolError)`：
// 成功时 *ProtocolError 为 nil；失败时 VerifyResult 为零值，*ProtocolError 携带
// 已分类的错误码（AUTH_INVALID_SIGNATURE / AUTH_EXPIRED_TIMESTAMP /
// AUTH_REPLAYED_NONCE / PROTOCOL_VERSION_UNSUPPORTED），供调用方经
// ProtocolError.Response() 转换为统一 JSON 错误响应，不得在 message 中回显
// 签名原文或密钥（AGENTS.md 安全规则 13）。
func (v *Verifier) VerifySignature(ctx context.Context, req SignedRequest) (VerifyResult, *ProtocolError) {
	if req.ProtocolVersion != ProtocolVersion {
		return VerifyResult{}, newProtocolError(ErrCodeProtocolVersionUnsupported, fmt.Sprintf("unsupported protocol version %q, expected %q", req.ProtocolVersion, ProtocolVersion))
	}

	ts, err := parseTimestamp(req.Timestamp)
	if err != nil {
		return VerifyResult{}, newProtocolError(ErrCodeAuthExpiredTimestamp, "invalid or missing timestamp")
	}

	now := v.now()
	window := v.timeWindow()
	if diff := now.Sub(ts); diff > window || diff < -window {
		return VerifyResult{}, newProtocolError(ErrCodeAuthExpiredTimestamp, "timestamp outside allowed window")
	}

	if req.AgentID == "" || req.Nonce == "" || req.Signature == "" {
		return VerifyResult{}, newProtocolError(ErrCodeAuthInvalidSignature, "missing required signature fields")
	}

	// 与 Sign()（T-002）共用同一份归一化逻辑（sign.go normalizeCallType），
	// 未声明 X-Call-Type 时按 production 重算基串，保持双方对默认值的理解一致
	// （design.md 模块 4；T-008）。取值不合法（既非 sandbox 也非 production）
	// 视为签名字段格式错误，直接拒绝。
	callType, err := normalizeCallType(req.CallType)
	if err != nil {
		return VerifyResult{}, newProtocolError(ErrCodeAuthInvalidSignature, "invalid call type")
	}

	keys, err := v.Keys.ActiveSigningKeys(ctx, req.AgentID)
	if err != nil || len(keys) == 0 {
		return VerifyResult{}, newProtocolError(ErrCodeAuthInvalidSignature, "no active signing key for agent")
	}

	// 复用 Sign()（T-002）的权威拼接逻辑，任何一方改动基串格式必须同步另一方
	// （AGENTS.md「同一业务规则只保留一个权威实现」；sign.go buildSignatureBase 注释同此约束）。
	base := buildSignatureBase(req.Method, req.Path, req.Timestamp, req.Nonce, callType, req.Body)

	matched := false
	for _, key := range keys {
		if signatureMatches(key, base, req.Signature) {
			matched = true
			break
		}
	}
	if !matched {
		return VerifyResult{}, newProtocolError(ErrCodeAuthInvalidSignature, "signature mismatch")
	}

	fresh, err := v.Nonces.ReserveNonce(ctx, req.AgentID, req.Nonce, now)
	if err != nil {
		return VerifyResult{}, newProtocolError(ErrCodeAuthInvalidSignature, "nonce store unavailable")
	}
	if !fresh {
		return VerifyResult{}, newProtocolError(ErrCodeAuthReplayedNonce, "nonce already used")
	}

	return VerifyResult{AgentID: req.AgentID, CallType: callType}, nil
}

// signatureMatches 用常数时间比较 computeHMACSignature(secret, base) 与调用方
// 提供的 hex 签名，避免时序攻击探测出部分正确的签名。计算逻辑复用
// computeHMACSignature（sign.go），不重新实现 HMAC 拼装。
func signatureMatches(secret string, base []byte, hexSignature string) bool {
	expectedHex := computeHMACSignature(secret, base)
	expected, err := hex.DecodeString(expectedHex)
	if err != nil {
		return false
	}
	given, err := hex.DecodeString(hexSignature)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(expected, given) == 1
}

// parseTimestamp 将 X-Timestamp 头部的十进制 Unix 秒字符串解析为 time.Time。
func parseTimestamp(raw string) (time.Time, error) {
	if raw == "" {
		return time.Time{}, fmt.Errorf("empty timestamp")
	}
	sec, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return time.Time{}, fmt.Errorf("timestamp not a valid unix seconds value: %w", err)
	}
	return time.Unix(sec, 0), nil
}
