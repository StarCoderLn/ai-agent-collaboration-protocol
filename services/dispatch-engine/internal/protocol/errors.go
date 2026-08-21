package protocol

import "net/http"

// ErrorCode 是协议层统一错误码，取值集合是本包的权威定义。
//
// design.md 模块 3 将错误码划分为四类重试/超时语义，新增错误码时必须归入
// 已有类别之一（通过 ErrorCode.retryable() 声明是否可安全重试同一请求），
// 不得引入脱离该分类模型的新语义。
type ErrorCode string

const (
	// ErrCodeAuthInvalidSignature：签名校验失败（签名值不匹配、格式错误等）。
	// 归类：认证失败。重复发送同一请求不会成功，需重新生成签名。
	ErrCodeAuthInvalidSignature ErrorCode = "AUTH_INVALID_SIGNATURE"

	// ErrCodeAuthExpiredTimestamp：请求时间戳超出允许的时间窗口（默认 ±5 分钟）。
	// 归类：认证失败。需要校正时钟或重新生成带当前时间戳的请求，不可盲目重试。
	ErrCodeAuthExpiredTimestamp ErrorCode = "AUTH_EXPIRED_TIMESTAMP"

	// ErrCodeAuthReplayedNonce：请求携带的 (timestamp, nonce) 组合已被使用过。
	// 归类：认证失败。同一 nonce 永久失效，需以新 nonce 重新发起请求。
	ErrCodeAuthReplayedNonce ErrorCode = "AUTH_REPLAYED_NONCE"

	// ErrCodeProtocolVersionUnsupported：请求携带的 X-Protocol-Version 平台不识别。
	// 归类：协议不兼容。需要调用方升级/降级协议版本后才能重试，原始请求不可重试。
	ErrCodeProtocolVersionUnsupported ErrorCode = "PROTOCOL_VERSION_UNSUPPORTED"

	// ErrCodeConnTimeout：平台调用 Agent（或 Agent 回调平台）时连接超时。
	// 归类：连接超时。可安全重试，调用方应使用指数退避（1s/2s/4s.../最多 5 次）。
	ErrCodeConnTimeout ErrorCode = "CONN_TIMEOUT"

	// ErrCodeAgentInternalError：Agent 侧返回内部错误。
	// 归类：Agent 内部错误。是否重试或更换候选 Agent 由上层业务（feature 9 派发）决定，
	// 本层只负责分类与上报，标记为 retryable 供上层参考，不代表本层会自动重试。
	ErrCodeAgentInternalError ErrorCode = "AGENT_INTERNAL_ERROR"
)

// retryable 声明该错误码对应的失败是否可以通过原样重试同一请求来恢复。
// 这是本包内的权威判定，ErrorResponse.Retryable 与 ErrorCode.HTTPStatus 均基于此，
// 调用方不应自行重新判断某个错误码是否可重试。
func (c ErrorCode) retryable() bool {
	switch c {
	case ErrCodeConnTimeout, ErrCodeAgentInternalError:
		return true
	default:
		return false
	}
}

// HTTPStatus 返回该错误码对应的 HTTP 状态码，供 HTTP 层写响应时使用。
func (c ErrorCode) HTTPStatus() int {
	switch c {
	case ErrCodeAuthInvalidSignature, ErrCodeAuthExpiredTimestamp, ErrCodeAuthReplayedNonce:
		return http.StatusUnauthorized
	case ErrCodeProtocolVersionUnsupported:
		return http.StatusBadRequest
	case ErrCodeConnTimeout:
		return http.StatusGatewayTimeout
	case ErrCodeAgentInternalError:
		return http.StatusBadGateway
	default:
		return http.StatusInternalServerError
	}
}

// ErrorResponse 是协议层统一的 JSON 错误响应结构（design.md「接口契约」）。
//
// message 字段不得包含密钥、签名原文等敏感信息（AGENTS.md 安全规则 13、
// design.md「安全考虑」）；调用方生成 message 时必须自行脱敏，本类型不做隐式过滤。
type ErrorResponse struct {
	ErrorCode ErrorCode `json:"error_code"`
	Message   string    `json:"message"`
	Retryable bool      `json:"retryable"`
}

// NewErrorResponse 构造统一错误响应，Retryable 由 code 的权威分类自动推导，
// 调用方不得手动指定 retryable 造成分类不一致。
func NewErrorResponse(code ErrorCode, message string) ErrorResponse {
	return ErrorResponse{
		ErrorCode: code,
		Message:   message,
		Retryable: code.retryable(),
	}
}

// ProtocolError 是协议层校验失败时返回的错误类型（实现 error 接口），
// 供 VerifySignature 等中间件在 Go 调用链中传递失败原因，最终经 Response()
// 转换为对外统一 JSON 结构。是否可重试仍由 Code.retryable() 唯一决定，
// 调用方不得另行判断（AGENTS.md「同一业务规则只保留一个权威实现」）。
type ProtocolError struct {
	Code    ErrorCode
	Message string
}

// Error 实现标准 error 接口，便于与 Go 惯用的错误处理方式组合。
func (e *ProtocolError) Error() string {
	return string(e.Code) + ": " + e.Message
}

// Response 转换为对外统一 JSON 错误响应结构（design.md「接口契约」）。
func (e *ProtocolError) Response() ErrorResponse {
	return NewErrorResponse(e.Code, e.Message)
}

// newProtocolError 是包内构造 *ProtocolError 的唯一入口，避免各调用点
// 各自拼装字段导致格式不一致。
func newProtocolError(code ErrorCode, message string) *ProtocolError {
	return &ProtocolError{Code: code, Message: message}
}
