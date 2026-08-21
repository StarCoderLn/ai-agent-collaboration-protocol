---
description: Go 与 TypeScript/Next.js 测试和验证规范
---

# Testing

## 当前阶段状态

- 项目已有 Go 分发引擎、TypeScript 业务领域模块、PostgreSQL migrations，以及 better-t-stack 的正式 Next.js Web 工程。
- 不得虚构未执行的命令或覆盖率数字；真实路由、认证、AWS KMS/Lambda 和端到端环境尚未落地时，必须明确区分单元/模拟验证与真实环境验证。

## 验证原则(AGENTS.md 强制门禁)

- 验证强度与风险相称:局部修改执行最接近改动的验证;高影响修改(公共接口、数据 schema、认证、资金、并发、部署、跨系统流程)需验证正常路径、边界条件、失败路径及相关回归。
- 不得声称未实际执行的验证已经通过。无法运行真实集成环境时，说明缺少的外部条件和影响。
- 完成任务前运行适用范围内的测试、类型检查、lint 和构建；纯文档修改至少执行冲突表述搜索与 `git diff --check`。

## services/dispatch-engine (Go) 测试规范

- 模块:`github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine`,`go.mod` 已确认为技术栈落地证据。
- 测试命令:`cd services/dispatch-engine && go test ./...`(单元/契约测试);`go build ./...` 作为编译验证;`go vet ./...` 作为 lint(当前未发现 `golangci-lint` 配置,如后续引入需在此补充)。
- 测试文件组织:与 Go 标准约定一致,`_test.go` 与被测源文件同包同目录;协议契约测试位于 `internal/protocol`。
- 高影响改动(签名认证、幂等、错误码、沙箱标记等 Agent 接入协议逻辑)必须覆盖正常路径、边界条件(重复请求/幂等键冲突)、失败路径(签名无效、超时)及回归用例,不得仅靠人工审阅替代。
- Mock/Stub 边界:签名密钥、Agent 沙箱凭据等如使用占位值,仅可用于本地/CI 测试,不得作为"生产可用"或"任务已完成"的证据;涉及资金托管、结算的服务一旦落地,须在此补充其专属最低覆盖要求。
- PostgreSQL、AWS KMS/Lambda、消息队列和合约的真实环境验证命令尚未全部落地；不得因此改变已冻结技术栈。

## services/business-api（TypeScript）

- `cd services/business-api && pnpm test`：Vitest 测试。
- `cd services/business-api && pnpm typecheck`：TypeScript 类型检查。
- `cd services/business-api && pnpm build`：构建验证。
- fake KMS 和内存持久化只证明领域行为，不证明真实 AWS KMS、PostgreSQL 事务或 Lambda 路由可用。

## web（正式 Next.js 工程）

- 使用 Node.js 22+，在 `web/` 执行 `pnpm test`、`pnpm check-types`、`pnpm exec biome check .` 和 `pnpm build`。
- 测试框架固定为 Vitest + Testing Library；测试文件与组件相邻或放在对应模块测试目录。
- 涉及表单凭证时，覆盖提交后清空明文、字段级错误映射和失败路径；不得把 mock fetch 通过视为真实 API 已联通。
