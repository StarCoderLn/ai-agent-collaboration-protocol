# Agent 注册与凭证管理 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 说明 `PATCH /api/agents/:id` 拒绝钱包地址修改是永久约束，换绑走 [[16.agent-wallet-rebind]] 单独接口 |
| 2026-08-20 | v3   | `agents` 表新增 `email` 必填字段 |
| 2026-08-21 | v4   | 冻结唯一前端与 Web 技术栈，禁止平行 Vite 应用 |
| 2026-08-22 | v5   | 新增模块 5（提供者钱包认证，SIWE），冻结 `services/business-api` 独立 Next.js API-only 应用骨架的部署形态；补充接口契约与技术决策 |
| 2026-08-24 | v6   | 补齐显式退出登录：服务端吊销不透明会话并清除 httpOnly Cookie，已登录钱包入口改为账户菜单 |
| 2026-08-25 | v7   | 新增独立 `payout_wallet_address`，所有权校验与结算收款不再共用同一字段 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（`services/business-api`，独立部署的 Next.js API-only 应用（无页面，仅 Route Handlers）+ AWS Lambda，承载 Agent 档案 CRUD 与 SIWE 认证）、PostgreSQL、前端（better-t-stack 的 `web/apps/web`，通过 `NEXT_PUBLIC_BUSINESS_API_URL` 跨服务调用业务 API）

## 功能模块设计

### 模块 1: Agent 档案数据模型

**涉及层及关键设计:**

- `agents` 表：`provider_wallet_address` 是 SIWE 所有者身份和管理权限的唯一依据；`payout_wallet_address` 只用于普通验收、仲裁释放和链上回执核对。两者允许不同，旧数据迁移时把原所有者地址回填为收款地址，保证升级前后资金去向不变。其他业务字段包括名称、分类、能力描述、标签、计价方式、报价、服务地址、状态与邮箱；邮箱只作为站外通知渠道，不是登录凭证。
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
- 收款钱包默认预填当前登录钱包，但保持可编辑；提交时所有者地址仍从 SIWE 会话读取，禁止用表单中的收款地址替代认证身份。
- “查看接入示例”提供可复制运行的 Node.js + TypeScript 模板，覆盖原始字节验签、时间窗口、Nonce、防重放、幂等与 `/healthz`；模板内存状态明确标注仅用于快速接入，生产环境须换为 Redis/数据库。
- 注册页与编辑页必须位于唯一正式应用 `web/apps/web`，使用 Next.js 16 App Router、React 19、Tailwind CSS、`web/packages/ui`、Zod、Vitest + Testing Library 和 Biome。不得保留或新增 Vite 平行应用。

### 模块 5: 提供者钱包认证（SIWE，`[v5 新增]`）

**涉及层及关键设计:**

- 采用 SIWE（EIP-4361）而非自定义签名方案：生态成熟、钱包客户端（MetaMask）原生支持消息展示，避免自造容易被误用的签名格式。
- `auth_sessions` 表（`session_id PK, wallet_address, expires_at, created_at`）与 `auth_nonces` 表（`nonce PK, expires_at, consumed_at NULL`）为本模块新增的平台级共享表：任何未来 feature 需要"当前操作者是哪个钱包地址"都复用同一张 `auth_sessions`，不得各自实现会话解析。
- session cookie 只放不透明 `session_id`（不是自解释 JWT），服务端持有 `auth_sessions` 才能校验/吊销，避免客户端可以伪造声明字段。
- `resolveActorId` 是单一权威的身份解析函数：所有需要身份的 handler（T-003/T-004/T-005/T-011 新增的 `GET /api/agents/:id`）都通过依赖注入调用它，不允许在多个 handler 里各自解析 cookie。
- nonce 单次使用、短 TTL（5 分钟），签名校验成功后立即标记 `consumed_at`，防止重放。
- 会话 TTL 24 小时，过期后要求重新走一遍 SIWE 流程；非目标：多设备会话管理、refresh token 轮换体验（记录为后续可能需要的技术债，不阻塞本轮交付）。
- 已登录状态再次点击钱包入口只打开账户菜单，不得重新申请 nonce 或触发 SIWE 签名。退出必须显式调用服务端吊销接口；仅清除 React 状态不能视为安全退出。

## 接口契约

- `GET /api/auth/nonce` 响应：`{ nonce, expiresAt }`。
- `POST /api/auth/verify` 请求体：`{ message, signature }`（`message` 为完整 SIWE 消息文本）；响应：`{ walletAddress }`，并通过 `Set-Cookie` 下发 httpOnly+Secure+SameSite=Lax 的 session cookie；失败（签名不符/nonce 过期或已用/地址格式非法）一律 401，不泄露具体校验失败在哪一步。
- `DELETE /api/auth/session`：按 Cookie 中的不透明 `session_id` 吊销服务端会话，并用 `Max-Age=0` 覆盖 httpOnly Cookie；缺少或已吊销会话时幂等返回 204，存储故障时返回可重试 503 且不得伪装成已退出。
- `GET /api/agents/:id`（`[v5 新增]`，T-011 承接）请求：需携带有效 session；响应：Agent 档案字段（不含 `encrypted_secret`），仅归属该 `provider_wallet_address` 的 session 可读取，否则 403。

- `POST /api/agents` 请求体：`{ name, categoryId, capabilityDesc, tags[], pricingType, price, walletAddress, payoutWalletAddress, serviceEndpoint, credentialSecret, email }`。`walletAddress` 必须等于认证 actor，`payoutWalletAddress` 只需是合法 Ethereum 地址且允许不同；响应：`{ agentId, status: "pending_review" }`。
- `PUT /api/agents/:id/credentials` 请求体：`{ credentialSecret }`；响应：`{ keyVersion, configured: true }`，不回显任何密钥相关字段。
- 错误响应复用 [[1.agent-protocol-contract]] 定义的统一错误码结构。

## 数据模型

- `agents(id PK, provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags TEXT[], pricing_type, price_amount, price_currency, service_endpoint, email, status, created_at, updated_at)`；两个钱包字段均做结构校验，只有前者参与归属鉴权。
- `agent_credentials(agent_id PK FK, encrypted_secret, key_version, updated_at)`
- `audit_logs(id PK, actor_id, actor_type, action, target_type, target_id, before_summary JSONB, after_summary JSONB, created_at)`（平台共享表，凭证类字段禁止写入 `before_summary`/`after_summary`）
- `auth_nonces(nonce PK, expires_at, consumed_at NULL, created_at)`（`[v5 新增]`，平台共享表）
- `auth_sessions(session_id PK, wallet_address, expires_at, created_at)`（`[v5 新增]`，平台共享表）

## 安全考虑

- 遵循 AGENTS.md §9：凭证、完整钱包签名不得出现在日志；`audit_logs` 的 summary 字段生成逻辑需显式排除凭证字段，而不是事后脱敏。
- 所有权限查询继续只读 `provider_wallet_address`；生成或核对 release 收款人时只读 `payout_wallet_address`，禁止通过一个兼具两种语义的字段隐式耦合权限与资金。
- `price_amount` 使用整数最小单位（不使用浮点数），与 [[5.escrow-contract-ethereum]] 的金额精度约定保持一致。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 承载服务 | Next.js + AWS Lambda（选中）vs Go 分发引擎 | 注册配置属于低频用户面 CRUD，Go 分发引擎应保持专注于派发路径的深模块职责，混入 CRUD 会扩大其接口面 |
| 前端工程 | better-t-stack `web/apps/web`（选中）vs 独立 Vite 应用 | 单一 App Router 应用统一路由、设计系统、环境变量、测试和部署边界，避免重复脚手架与迁移成本 |
| 凭证存储 | 应用层信封加密 + 物理分表（选中）vs 数据库透明加密（TDE） | TDE 无法阻止“查询到但被解密返回”的误用路径；应用层加密从接口设计上直接消除“读明文”的可能性 |
| `services/business-api` 部署形态 | 独立 Next.js API-only 应用（选中）vs 合并进 `web/apps/web` | 用户 2026-08-22 确认维持既有冻结决定：业务 API 需要独立的数据库/KMS 权限边界，与前端部署单元分开；代价是多一套 Next.js 脚手架与构建/部署流水线，已知悉并接受 |
| 提供者钱包认证协议 | SIWE / EIP-4361（选中）vs 请求级签名校验（无会话） | 用户 2026-08-22 确认选 SIWE：生态成熟、钱包客户端原生支持消息展示；代价是需要新增 `auth_nonces`/`auth_sessions` 两张表和会话生命周期管理，比无会话的请求级签名复杂，但用户体验更好（不必每次请求都弹签名） |
