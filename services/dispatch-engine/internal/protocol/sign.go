package protocol

import (
	"bytes"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"time"
)

// 签名相关请求头名称（design.md 模块 1「请求头」）。X-Protocol-Version 复用
// version.go 中已定义的 HeaderProtocolVersion，不在此重复定义同一常量。
const (
	HeaderTimestamp = "X-Timestamp"
	HeaderNonce     = "X-Nonce"
	HeaderSignature = "X-Signature"
	// HeaderCallType 承载沙箱模式标记（design.md 模块 4 / v2 新增，F-006）。
	HeaderCallType = "X-Call-Type"
)

// CallType 标记一次调用是沙箱调用还是正式任务调用（design.md 模块 4）。
// 取值集合与 idempotency_records.call_type 的 CHECK 约束一致（T-004 migration），
// 本包是该取值集合的权威定义，其余位置不得重新声明同构枚举。
type CallType string

const (
	// CallTypeProduction 是未显式声明 call_type 时的默认值：把遗漏标记的调用当
	// 正式任务处理，避免沙箱调用因遗漏标记被误计入正式历史（design.md 技术决策：
	// 沙箱标记默认值——遗漏应更保守）。
	CallTypeProduction CallType = "production"
	// CallTypeSandbox 标记 15.agent-sandbox-admission 发起的沙箱调用，需调用方显式声明。
	CallTypeSandbox CallType = "sandbox"
)

// normalizeCallType 是 Sign()/VerifySignature() 共用的 call_type 归一化与校验
// 逻辑（唯一权威实现，AGENTS.md「同一业务规则只保留一个权威实现」）：
//   - 空值归一化为 CallTypeProduction（design.md「默认值为 production」）。
//   - 非法取值（既非 production 也非 sandbox）视为格式错误，直接拒绝，不静默
//     纳入签名基串——否则会把未经校验的字符串写入后续落库的 call_type 字段，
//     依赖数据库 CHECK 约束兜底而非在协议层提前拒绝。
func normalizeCallType(ct CallType) (CallType, error) {
	if ct == "" {
		return CallTypeProduction, nil
	}
	if ct != CallTypeProduction && ct != CallTypeSandbox {
		return "", fmt.Errorf("protocol: invalid call type %q, must be %q or %q", ct, CallTypeProduction, CallTypeSandbox)
	}
	return ct, nil
}

// nonceByteLength 决定生成的 nonce 熵；16 字节（128 bit）足以在协议要求的时间
// 窗口（默认 ±5 分钟）内保证碰撞概率可忽略，同时不必引入比 crypto/rand 更重的依赖。
const nonceByteLength = 16

// SignRequest 承载生成签名所需的最小请求要素：平台调用 Agent 时的 HTTP method、
// path 与 body。只取参与签名基串计算的字段，不接收完整 *http.Request，避免签名
// 逻辑意外依赖未被 buildSignatureBase 覆盖的部分（如 query string、其他 header），
// 那样会造成"签名看似生成成功、实际未覆盖调用方以为受保护的字段"的隐藏漏洞。
type SignRequest struct {
	// Method 是 HTTP 方法（如 "POST"），大小写按调用方原样传入，Sign 不做归一化；
	// VerifySignature（T-003）必须使用与出站请求完全一致的大小写重算签名。
	Method string
	// Path 是请求路径（不含协议、host、query string）。
	Path string
	// Body 是请求体原始字节；无请求体时传 nil 或空切片，两者签名结果相同。
	Body []byte
}

// SignedHeaders 是 Sign() 生成、调用方需要附加到出站请求上的协议头集合。
type SignedHeaders struct {
	ProtocolVersion string
	Timestamp       string
	Nonce           string
	Signature       string
	// CallType 对应 X-Call-Type 请求头（design.md 模块 4 / v2 新增）。始终为
	// CallTypeProduction 或 CallTypeSandbox（Sign() 已完成归一化），调用方据此
	// 设置出站请求头，不需要自行处理默认值。
	CallType CallType
}

// Sign 为平台→Agent 的出站请求生成协议签名头（design.md 模块 1「请求签名与认证」，
// 接口契约 `Sign(req, secret, callType) SignedHeaders`）。
//
// 签名算法固定为 HMAC-SHA256，基串由 buildSignatureBase 按
// method + path + timestamp + nonce + callType + body 的顺序拼接而成——这是该
// 拼接规则的唯一权威实现，VerifySignature（T-003/T-008）必须复用同一函数重算
// 基串，不得各自实现一份等价逻辑，否则签名双方会因基串定义漂移而互相拒绝合法
// 请求（AGENTS.md 5.1.2「同一业务规则只保留一个权威实现」）。
//
// callType 为空时归一化为 CallTypeProduction（design.md F-006「默认值为
// production」）；15.agent-sandbox-admission 发起沙箱调用时须显式传
// CallTypeSandbox。callType 纳入签名基串，防止被中间人篡改为绕过沙箱标记
// （design.md 模块 4）。
//
// secret 由调用方从 feature 2（Agent 注册）写入的加密凭证中读取后传入；本函数只
// 消费 secret，不负责其存储或轮换（design.md「安全考虑」：读取路径与存储路径分离）。
// secret 为空、或 Method/Path 缺失时返回错误而不是生成"看似有效"的签名——用空密钥
// 或不完整请求要素静默签名，会产出任何人都能伪造或重放的签名，比显式失败更危险。
func Sign(req SignRequest, secret string, callType CallType) (SignedHeaders, error) {
	if secret == "" {
		return SignedHeaders{}, errors.New("protocol: sign secret must not be empty")
	}
	if req.Method == "" || req.Path == "" {
		return SignedHeaders{}, errors.New("protocol: sign request method and path are required")
	}
	normalizedCallType, err := normalizeCallType(callType)
	if err != nil {
		return SignedHeaders{}, err
	}

	nonce, err := generateNonce()
	if err != nil {
		return SignedHeaders{}, fmt.Errorf("protocol: generate nonce: %w", err)
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)

	base := buildSignatureBase(req.Method, req.Path, timestamp, nonce, normalizedCallType, req.Body)
	signature := computeHMACSignature(secret, base)

	return SignedHeaders{
		ProtocolVersion: ProtocolVersion,
		Timestamp:       timestamp,
		Nonce:           nonce,
		Signature:       signature,
		CallType:        normalizedCallType,
	}, nil
}

// buildSignatureBase 组装 HMAC 签名基串：method、path、timestamp、nonce、
// callType、body 依次拼接，分量之间以 "\n" 分隔，避免相邻字段拼接产生歧义（例如
// method="GET", path="Apath" 与 method="GETA", path="path" 若不加分隔符会得到
// 相同基串，body 因此始终放在末尾且不加分隔符，因为 body 本身可以是任意字节且没有
// 后续分量需要与之区分）。
//
// callType 是 T-008 新增分量（design.md 模块 4），纳入签名基串防止 X-Call-Type
// 被篡改为绕过沙箱标记；调用方必须传入已经过 normalizeCallType 归一化的值，本函数
// 只负责拼接、不重复校验，避免校验逻辑散落两处。
//
// 这是该拼接规则的唯一权威实现，Sign()/VerifySignature() 均须复用本函数重算基串，
// 不得各自实现一份等价逻辑。
func buildSignatureBase(method, path, timestamp, nonce string, callType CallType, body []byte) []byte {
	var buf bytes.Buffer
	buf.WriteString(method)
	buf.WriteByte('\n')
	buf.WriteString(path)
	buf.WriteByte('\n')
	buf.WriteString(timestamp)
	buf.WriteByte('\n')
	buf.WriteString(nonce)
	buf.WriteByte('\n')
	buf.WriteString(string(callType))
	buf.WriteByte('\n')
	buf.Write(body)
	return buf.Bytes()
}

// computeHMACSignature 计算 base 相对 secret 的 HMAC-SHA256，并以十六进制字符串
// 返回，供 X-Signature 请求头直接使用。
func computeHMACSignature(secret string, base []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(base)
	return hex.EncodeToString(mac.Sum(nil))
}

// generateNonce 生成一次性、高熵、URL 安全的随机字符串，用于配合时间戳防重放
// （design.md 模块 1；F-004）。使用 crypto/rand 而非 math/rand，因为 nonce 的
// 不可预测性是防重放机制成立的前提，可预测的 nonce 等同于没有防重放保护。
func generateNonce() (string, error) {
	buf := make([]byte, nonceByteLength)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(buf), nil
}
