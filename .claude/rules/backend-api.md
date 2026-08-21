---
description: Go backend (dispatch-engine) API 开发规范
globs: services/dispatch-engine/**
---

# Backend API 规则

适用范围：`services/dispatch-engine`（Go module `github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine`）。项目未检测到外部 Web 框架，默认沿用标准库风格（`net/http` + 自定义 router/middleware）；引入框架前需在高影响决策摘要中说明理由。

## 常用命令

- 安装依赖：`go mod download`
- 本地运行：`go run ./services/dispatch-engine`
- 构建：`go build ./...`
- 测试：`go test ./...`
- 静态检查：`go vet ./...`（未发现 golangci-lint 配置，如需更严格 lint 需先与用户确认引入）

## 接口设计

1. 对外 HTTP/RPC 接口保持简单、稳定、完整（深模块原则）：内部实现细节、依赖装配、错误映射不得泄漏到接口签名或响应结构。
2. 请求/响应结构、错误码、分页规则等业务规则集中定义在单一权威位置（如 `internal/api` 或对应包），避免多处重复定义或手写字符串拼接路由。
3. 新增接口前确认是否已有等价能力，避免为同一业务规则创建多个入口。
4. 修改已发布的公共 API（路径、字段、语义）属于高影响任务，实施前必须输出 AGENTS.md 规定的高影响决策摘要。

## 错误处理与幂等

5. 所有对外接口需明确错误处理路径（参数校验、下游失败、超时），不得吞掉错误或仅记录日志后静默返回成功。
6. 涉及状态变更、外部 Agent 回调、资金/托管相关的接口，必须显式设计幂等性（如幂等键、状态机校验），并说明重试语义。
7. 涉及并发访问的共享状态需说明加锁或事务边界，不得依赖偶然的调用顺序保证正确性。

## 验证与提交前检查

8. 修改后按风险相称原则运行验证：局部改动至少运行 `go build ./...` 与相关包的 `go test`；涉及公共接口/并发/状态迁移的改动需运行 `go vet ./...` 和完整 `go test ./...`。
9. 不得声称未实际执行的验证已通过；无法运行时说明原因及用户可执行的命令。
10. 本项目当前无 CI/Makefile 配置，验证命令需在任务说明中手动列出，不得假设存在自动化流水线。
