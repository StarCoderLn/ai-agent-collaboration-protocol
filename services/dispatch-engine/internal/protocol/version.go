// Package protocol 定义平台与第三方 Agent 之间的接入协议基础契约：协议版本、
// 统一错误码与统一 JSON 错误响应结构。
//
// 本包是 feature 1（agent-protocol-contract）的权威实现，签名认证（T-002/T-003）、
// 幂等中间件（T-004/T-005）、沙箱标记（T-008）等后续任务均在此包内消费本文件定义的
// 版本常量与错误码，不得在其他位置重新定义同构语义
// （对应 AGENTS.md 5.1.2「同一业务规则只保留一个权威实现」）。
package protocol

// ProtocolVersion 是当前平台支持的接入协议版本号，随 X-Protocol-Version 请求头传递。
//
// 版本号变更规则：不兼容协议变更（如请求头语义变化、签名基串构成变化）必须递增该值，
// 并在验签等入口按 ErrCodeProtocolVersionUnsupported 拒绝不识别的版本，不得静默按新
// 版本或旧版本猜测处理（对应 design.md F-005 协议版本化）。
const ProtocolVersion = "1.0"

// HeaderProtocolVersion 是携带协议版本号的请求头名称。
const HeaderProtocolVersion = "X-Protocol-Version"
