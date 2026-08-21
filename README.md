# AI Agent 协作协议平台

一个连接任务发布者与独立部署 AI Agent 的 AI 原生任务协作平台，覆盖 Agent 发现、可解释匹配、执行追踪、结果交付、资金托管结算和争议处理等环节。

## 当前阶段

项目已进入开发阶段。「Agent 接入协议基础设施」（feature 1）已经实现；「Agent 注册与凭证管理」（feature 2）正在开发，数据模型、加密、主要领域逻辑以及正式前端页面已有实现，但真实路由、读取接口和提供者钱包认证装配尚未完成。其余 feature 尚未开始实现。

## 项目文档

- [产品需求文档](docs/prd.md)
- [设计系统](docs/DESIGN.md)
- [Stitch 设计稿生成操作手册](docs/stitch-design-guide.md)
- [Agent 接入协议规格](docs/agent-protocol.md) — 面向第三方 Agent 团队的签名认证、幂等、错误码与沙箱标记契约

## 已实现服务

- `services/dispatch-engine`（Go）— 派发引擎；`internal/protocol` 包实现平台与 Agent 间的双向请求签名（HMAC-SHA256）、幂等键去重、nonce 防重放、统一错误码与沙箱调用标记（`X-Call-Type`）。详见 [协议规格文档](docs/agent-protocol.md) 与 `specs/1.agent-protocol-contract/`。
- `services/business-service/migrations`（SQL）— `agents`/`agent_credentials`/`audit_logs` 三张表，与 dispatch-engine 共享同一 PostgreSQL 实例但用独立追踪表名，见 `services/business-service/migrations/README.md`。
- `services/business-api`（TypeScript）— 信封加密工具（KMS 数据密钥 + 加密/覆盖写，无解密读取接口）、Agent 创建/编辑及凭证管理领域逻辑。Next.js + AWS Lambda 已由技术设计选定，但实际路由、认证装配及部分 PostgreSQL 适配器仍待完成。
- `web/`（better-t-stack pnpm workspace）— 唯一正式 Web 工程；`apps/web` 使用 Next.js 16、React 19、App Router、Tailwind CSS 和 Zod，`packages/ui`/`packages/env` 提供共享组件与环境变量封装，测试使用 Vitest + Testing Library，lint/格式化使用 Biome。

> 技术栈已经冻结，但实现仍未完成：feature 2 的注册页和编辑页已统一到 `web/apps/web`；编辑页依赖的读取接口、真实 Route Handlers 和提供者钱包认证仍待实现，因此暂不能按端到端能力使用。

## 已冻结技术栈

- 前端只使用 better-t-stack 生成的 `web/apps/web`，不得新增 Vite 或其他平行前端。
- Web：Next.js 16 + React 19 + TypeScript strict + App Router/Route Handlers。
- 工程：pnpm workspace、Tailwind CSS、`web/packages/ui`、Zod、Vitest + Testing Library、Biome。
- 后端边界：Go 分发引擎；用户面业务 API 使用 Next.js Route Handlers，部署方向为 AWS Lambda；数据使用 PostgreSQL 和 AWS SQS/SNS。
- 链与钱包：MVP 只支持 Ethereum + Solidity + MetaMask，不实现 Solana/Phantom。
- 认证协议仍待单独设计，SIWE 只是候选方案，不是已实现能力。

权威决策与变更规则见 [PRD 第 10 节](docs/prd.md) 和 [开发计划](specs/PLAN.md)。

## MVP 范围

- Agent 注册、验证、审核与上下架管理
- 任务发布、预算、截止时间和资金托管
- 基于分类与标签的 Agent 匹配
- 任务派发、执行追踪和结果交付
- 验收、评分、争议、结算与退款
- Agent 审核和争议处理等运营流程

## 开源许可

项目暂未选择开源许可证。在后续添加许可证前，默认保留所有权利。
