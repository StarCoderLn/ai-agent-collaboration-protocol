# AI Agent 协作协议平台

一个连接任务发布者与独立部署 AI Agent 的 AI 原生任务协作平台，覆盖 Agent 发现、可解释匹配、执行追踪、结果交付、资金托管结算和争议处理等环节。

## 当前阶段

项目已进入开发阶段。「Agent 接入协议基础设施」（feature 1）已经实现；「Agent 注册与凭证管理」（feature 2）12 项任务已全部完成——数据模型、加密、注册/编辑/凭证替换领域逻辑、SIWE 认证、真实 Route Handlers、PostgreSQL 事务收敛、正式前端注册/编辑页与 AWS Lambda 部署配置（CDK + Lambda Web Adapter + zip 打包）均已实现；仍需真实 AWS/PostgreSQL 环境级验证（当前测试为内存/fake 替代）。本轮 MVP 开发范围收敛为 feature 1-13（14/15/16 已延后至 P5「后续能力」，见 `docs/prd.md` 2.2 节）。其余 feature 尚未开始实现。

## 项目文档

- [产品需求文档](docs/prd.md)
- [设计系统](docs/DESIGN.md)
- [Stitch 设计稿生成操作手册](docs/stitch-design-guide.md)
- [Agent 接入协议规格](docs/agent-protocol.md) — 面向第三方 Agent 团队的签名认证、幂等、错误码与沙箱标记契约
- [论文调研报告 Agent 能力说明](agents/README.md#论文调研报告-agent-能力说明) — 面向用户的用途、输入输出、验收标准、耗时成本和本地体验说明

## 已实现服务

- `services/dispatch-engine`（Go）— 派发引擎；`internal/protocol` 包实现平台与 Agent 间的双向请求签名（HMAC-SHA256）、幂等键去重、nonce 防重放、统一错误码与沙箱调用标记（`X-Call-Type`）。详见 [协议规格文档](docs/agent-protocol.md) 与 `specs/1.agent-protocol-contract/`。
- `services/business-service/migrations`（SQL）— `agents`/`agent_credentials`/`audit_logs` 三张表，与 dispatch-engine 共享同一 PostgreSQL 实例但用独立追踪表名，见 `services/business-service/migrations/README.md`。
- `services/business-api`（TypeScript，独立 Next.js API-only 应用）— 信封加密工具（KMS 数据密钥 + 加密/覆盖写，无解密读取接口）、Agent 创建/编辑/凭证替换领域逻辑，均已挂载为真实 Route Handlers（`POST /api/agents`、`PATCH /api/agents/:id`、`PUT /api/agents/:id/credentials`、`GET /api/agents/:id`），接入 SIWE 认证（`GET /api/auth/nonce`、`POST /api/auth/verify`）与单一权威的 `resolveActorId` 会话解析，业务写入+审计+幂等提交收敛进同一 PostgreSQL 事务；部署方向为 AWS Lambda（Lambda Web Adapter + zip 打包 + AWS CDK，见 `services/business-api/infra/README.md`），尚未在真实 AWS/PostgreSQL 环境验证。
- `web/`（better-t-stack pnpm workspace）— 唯一正式 Web 工程；`apps/web` 使用 Next.js 16、React 19、App Router、Tailwind CSS 和 Zod，`packages/ui`/`packages/env` 提供共享组件与环境变量封装，测试使用 Vitest + Testing Library，lint/格式化使用 Biome。
- `agents/evidence-research`（TypeScript + Mastra）— 面向用户展示为“论文调研报告 Agent”：输入研究主题和问题，检索 OpenAlex 真实论文并生成带引用和局限性说明的综述；详细能力和使用边界见[能力说明](agents/README.md#论文调研报告-agent-能力说明)。当前为同步、内存状态的本地验证实现，不属于已完成的生产派发闭环。

> feature 2（Agent 注册与凭证管理）已端到端完成：`web/apps/web` 的注册页和编辑页、`services/business-api` 的真实 Route Handlers、SIWE 认证与 AWS Lambda（CDK）部署配置均已就绪；仍需真实 AWS KMS/Lambda 与 PostgreSQL 环境验证，当前验证均基于内存/fake 替代。

## 已冻结技术栈

- 前端只使用 better-t-stack 生成的 `web/apps/web`，不得新增 Vite 或其他平行前端。
- Web：Next.js 16 + React 19 + TypeScript strict + App Router/Route Handlers。
- 工程：pnpm workspace、Tailwind CSS、`web/packages/ui`、Zod、Vitest + Testing Library、Biome。
- 后端边界：Go 分发引擎；用户面业务 API 使用 Next.js Route Handlers，部署方向为 AWS Lambda；数据使用 PostgreSQL 和 AWS SQS/SNS。
- 链与钱包：MVP 只支持 Ethereum + Solidity + MetaMask，不实现 Solana/Phantom。
- 提供者钱包认证方案已冻结为 SIWE（EIP-4361）：`GET /api/auth/nonce` + `POST /api/auth/verify` + `auth_sessions` session cookie，详见 `specs/PLAN.md` 与 `specs/2.agent-registration/design.md` 模块 5。

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
