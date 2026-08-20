# Agent 注册与凭证管理 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 说明 `PATCH /api/agents/:id` 拒绝钱包地址修改是永久约束，换绑走 [[16.agent-wallet-rebind]] 单独接口 |
| 2026-08-20 | v3   | `agents` 表新增 `email` 必填字段 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（Next.js + AWS Lambda，承载 Agent 档案 CRUD）、PostgreSQL、前端（better-t-stack）

## 功能模块设计

### 模块 1: Agent 档案数据模型

**涉及层及关键设计:**

- `agents` 表：业务展示字段（名称、分类、能力描述、标签、计价方式、报价、服务地址、钱包地址、状态、`[v3 新增]` 邮箱）。邮箱不是登录凭证（平台鉴权走钱包签名），只作为站外通知渠道，因此校验规则只要求格式合法，不要求验证邮箱所有权（不发验证邮件阻断注册流程）——[[16.agent-wallet-rebind]] 换绑通知场景下，如果邮箱本身是错的，收不到通知本身就是一种保护（换绑请求不会被误确认），不需要在注册阶段做更强的邮箱验证。
- `agent_credentials` 表与 `agents` 物理分离：只存 `encrypted_secret`（应用层加密后的密文）、`key_version`、`updated_at`，任何联表查询都不会因为 `SELECT *` 意外带出凭证密文。
- 平台级共享 `audit_logs` 表在此首次定义，后续 feature（3、7、9、12、13）复用同一张表，避免审计知识散落多处。

### 模块 2: 凭证加密存储

**涉及层及关键设计:**

- 应用层使用信封加密：业务服务从密钥管理服务（AWS KMS）获取数据密钥加密凭证明文，数据库只存密文与 `key_version`；服务本身不持久化数据密钥。
- 替换凭证 = 用新明文重新走一次加密流程并覆盖 `encrypted_secret` + 递增 `key_version`，不提供解密读取接口（接口层面直接不存在“读明文”这个操作，用契约消除误用可能，而非靠权限控制兜底）。

### 模块 3: 注册/配置 API

**涉及层及关键设计:**

- `POST /api/agents`：创建档案，服务端二次校验（不信任前端校验），失败返回字段级错误。
- `PATCH /api/agents/:id`：编辑除钱包地址外的字段；`[v2]` 拒绝钱包地址字段是永久性约束，不是"暂未实现"——换绑必须走 [[16.agent-wallet-rebind]] 的独立签名验证+冷静期流程，本接口不提供任何绕过路径。
- `PUT /api/agents/:id/credentials`：覆盖写凭证，返回值只含 `key_version` 与配置状态。
- 选择 Next.js + AWS Lambda 而非 Go 分发引擎承载本模块：注册/配置是用户面 CRUD，非高吞吐派发路径，与 PRD §10 中“交易相关服务”职责边界一致，避免 Go 分发引擎承担与任务派发无关的业务知识。

### 模块 4: 前端注册与配置页面

**涉及层及关键设计:**

- 表单遵循 `docs/DESIGN.md` 视觉规范（Inter 字体、8px 间距、12px 卡片圆角、语义色）；钱包地址字段使用等宽字体展示。
- 字段级错误展示在对应输入项下方，不使用整页 toast 汇总（可扫描性要求）。
- 凭证输入框提交后立即清空本地状态，不缓存明文到前端 store。

## 接口契约

- `POST /api/agents` 请求体：`{ name, categoryId, capabilityDesc, tags[], pricingType, price, walletAddress, serviceEndpoint, credentialSecret, email }`（`[v3]` 新增 `email`）；响应：`{ agentId, status: "draft" }`。
- `PUT /api/agents/:id/credentials` 请求体：`{ credentialSecret }`；响应：`{ keyVersion, configured: true }`，不回显任何密钥相关字段。
- 错误响应复用 [[1.agent-protocol-contract]] 定义的统一错误码结构。

## 数据模型

- `agents(id PK, provider_wallet_address, name, category_id, capability_desc, tags TEXT[], pricing_type, price_amount, price_currency, service_endpoint, email, status, created_at, updated_at)`（`[v3]` 新增 `email`）
- `agent_credentials(agent_id PK FK, encrypted_secret, key_version, updated_at)`
- `audit_logs(id PK, actor_id, actor_type, action, target_type, target_id, before_summary JSONB, after_summary JSONB, created_at)`（平台共享表，凭证类字段禁止写入 `before_summary`/`after_summary`）

## 安全考虑

- 遵循 AGENTS.md §9：凭证、完整钱包签名不得出现在日志；`audit_logs` 的 summary 字段生成逻辑需显式排除凭证字段，而不是事后脱敏。
- `price_amount` 使用整数最小单位（不使用浮点数），与 [[5.escrow-contract-ethereum]] 的金额精度约定保持一致。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 承载服务 | Next.js + AWS Lambda（选中）vs Go 分发引擎 | 注册配置属于低频用户面 CRUD，Go 分发引擎应保持专注于派发路径的深模块职责，混入 CRUD 会扩大其接口面 |
| 凭证存储 | 应用层信封加密 + 物理分表（选中）vs 数据库透明加密（TDE） | TDE 无法阻止“查询到但被解密返回”的误用路径；应用层加密从接口设计上直接消除“读明文”的可能性 |
