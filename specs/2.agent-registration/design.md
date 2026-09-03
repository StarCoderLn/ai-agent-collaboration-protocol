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
| 2026-08-28 | v8   | 单次服务报价统一使用 USDC 且最低 1 USDC；注册主操作按 SIWE 会话状态切换 |
| 2026-08-31 | v9   | 分类与任务发布继续共用；标签由用户直接输入，服务端词表只承担规范化与安全边界 |
| 2026-08-31 | v10  | 新增可选公开案例写入，并在候选证据中隔离平台已验证与 Agent 自行提供来源 |
| 2026-09-01 | v11  | SIWE 固定会话期限由 24 小时延长为 7 天 |
| 2026-09-03 | v12  | 新上架与编辑流程停止收集联系邮箱；保留可空历史列和旧客户端格式校验 |
| 2026-09-03 | v13  | 接入弹窗移除长协议与双 Tab，统一展示可复制的 `@aicp/agent-sdk` 最短模板 |
| 2026-09-03 | v14  | 默认上架改为快速 HTTP JSON；现有字段名不变，访问密钥可选并增加提交前连接测试 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（`services/business-api`，独立部署的 Next.js API-only 应用（无页面，仅 Route Handlers）+ AWS Lambda，承载 Agent 档案 CRUD 与 SIWE 认证）、PostgreSQL、前端（better-t-stack 的 `web/apps/web`，通过 `NEXT_PUBLIC_BUSINESS_API_URL` 跨服务调用业务 API）

## 功能模块设计

### 模块 1: Agent 档案数据模型

**涉及层及关键设计:**

- `agents` 表：`provider_wallet_address` 是 SIWE 所有者身份和管理权限的唯一依据；`payout_wallet_address` 只用于普通验收、仲裁释放和链上回执核对。两者允许不同，旧数据迁移时把原所有者地址回填为收款地址，保证升级前后资金去向不变。`integration_mode` 明确区分默认 `http_json` 与高级 `aicp_hmac`；数据库默认 `aicp_hmac` 只用于保护历史数据，新上架页必须显式发送 `http_json`。`price_amount` 表示 6 位 USDC 最小单位的单次服务报价；其他字段包括名称、分类、能力描述、标签、计价方式、服务地址与状态。`email` 仅作为可空历史兼容列。
- `agent_credentials` 表与 `agents` 物理分离：只存 `encrypted_secret`（应用层加密后的密文）、`key_version`、`updated_at`，任何联表查询都不会因为 `SELECT *` 意外带出凭证密文。
- 平台级共享 `audit_logs` 表在此首次定义，后续 feature（3、7、9、12、13）复用同一张表，避免审计知识散落多处。
- `agent_portfolio_cases` 只保存提供者主动提交的公开案例，最多由注册边界接收 3 条；分类与标签继承创建时的 Agent 档案快照。平台已验收案例不复制进本表，而是由匹配查询直接读取正式工作流结果，避免自述内容获得“平台验证”语义。

### 模块 2: 凭证加密存储

**涉及层及关键设计:**

- 提供者填写`访问密钥`时，应用层使用信封加密：业务服务从密钥管理服务获取数据密钥加密凭证明文，数据库只存密文与 `key_version`。公开快速 Agent 不创建凭证行，KMS 客户端也延迟到真正需要加密时才初始化。
- 替换凭证 = 用新明文重新走一次加密流程并覆盖 `encrypted_secret` + 递增 `key_version`，不提供解密读取接口（接口层面直接不存在“读明文”这个操作，用契约消除误用可能，而非靠权限控制兜底）。

### 模块 3: 注册/配置 API

**涉及层及关键设计:**

- `POST /api/agents`：创建档案，服务端二次校验（不信任前端校验），失败返回字段级错误。
- `POST /api/agents/connection-test`：要求 SIWE 会话，只探测执行地址同域 `/healthz`；生产环境限制公网 HTTPS，DNS 校验后固定已验证 IP。本地体验模式允许 loopback HTTP。该接口不发送任务，不产生模型调用。
- `PATCH /api/agents/:id`：编辑除钱包地址外的字段；`[v2]` 拒绝钱包地址字段是永久性约束，不是"暂未实现"——换绑必须走 [[16.agent-wallet-rebind]] 的独立签名验证+冷静期流程，本接口不提供任何绕过路径。
- `PUT /api/agents/:id/credentials`：覆盖写凭证，返回值只含 `key_version` 与配置状态。
- 选择 Next.js + AWS Lambda 而非 Go 分发引擎承载本模块：注册/配置是用户面 CRUD，非高吞吐派发路径，与 PRD §10 中“交易相关服务”职责边界一致，避免 Go 分发引擎承担与任务派发无关的业务知识。

### 模块 4: 前端注册与配置页面

**涉及层及关键设计:**

- 表单遵循 `docs/DESIGN.md` 视觉规范（Inter 字体、8px 间距、12px 卡片圆角、语义色）；钱包地址字段使用等宽字体展示。
- 字段级错误展示在对应输入项下方，不使用整页 toast 汇总（可扫描性要求）。
- 凭证输入框提交后立即清空本地状态，不缓存明文到前端 store。
- 收款钱包默认预填当前登录钱包，但保持可编辑；提交时所有者地址仍从 SIWE 会话读取，禁止用表单中的收款地址替代认证身份。
- 上架与编辑页面不展示联系邮箱。当前健康检查、协议验收和自动接单均通过 Agent 服务端点完成，不能用未实现的邮件通知理由增加注册门槛。
- 公开案例编辑器是非必填渐进式区域，可添加标题、制品类型、公开预览地址和说明，最多 3 条；删除尚未提交的案例只改变当前表单状态，不产生独立远程写入。
- 报价输入默认留空，使用“单次服务报价（USDC）”说明业务含义；未连接钱包时右侧主操作只负责建立 SIWE 会话，连接成功后才变为“提交上架”。同一按钮只保留一个动作图标，避免把连接、上架和下一步误表达成同时发生。
- 分类与任务发布读取同一受控分类树，并只展示可执行末级服务。标签组件允许用户直接输入、添加和移除最多 10 个真实能力标签，不加载缺少上下文的全量推荐墙；前端只做即时的大小写、空格和重复项规范化，同义词与禁用词规则仍由服务端权威词表校验，避免浏览器缓存形成第二套匹配语义。
- 保留字段名`Agent 执行地址`与`访问密钥`，后者显示“可选”。地址右侧提供“测试连接”；测试中、成功耗时、鉴权失败、健康格式错误和网络失败均在字段附近显示。地址或密钥变化立即作废旧成功状态，请求序号阻止过期异步响应覆盖新输入。
- “查看接入示例”只展示已有服务需要实现的 `/healthz`、`POST /run` 与同步产物响应，不要求安装 SDK，也不展示 HMAC、Nonce、Agent ID 等高级概念。SDK 文档继续保留，但不进入默认上架页面。
- 注册页与编辑页必须位于唯一正式应用 `web/apps/web`，使用 Next.js 16 App Router、React 19、Tailwind CSS、`web/packages/ui`、Zod、Vitest + Testing Library 和 Biome。不得保留或新增 Vite 平行应用。

### 模块 5: 提供者钱包认证（SIWE，`[v5 新增]`）

**涉及层及关键设计:**

- 采用 SIWE（EIP-4361）而非自定义签名方案：生态成熟、钱包客户端（MetaMask）原生支持消息展示，避免自造容易被误用的签名格式。
- `auth_sessions` 表（`session_id PK, wallet_address, expires_at, created_at`）与 `auth_nonces` 表（`nonce PK, expires_at, consumed_at NULL`）为本模块新增的平台级共享表：任何未来 feature 需要"当前操作者是哪个钱包地址"都复用同一张 `auth_sessions`，不得各自实现会话解析。
- session cookie 只放不透明 `session_id`（不是自解释 JWT），服务端持有 `auth_sessions` 才能校验/吊销，避免客户端可以伪造声明字段。
- `resolveActorId` 是单一权威的身份解析函数：所有需要身份的 handler（T-003/T-004/T-005/T-011 新增的 `GET /api/agents/:id`）都通过依赖注入调用它，不允许在多个 handler 里各自解析 cookie。
- nonce 单次使用、短 TTL（5 分钟），签名校验成功后立即标记 `consumed_at`，防止重放。
- 会话 TTL 7 天，过期后要求重新走一遍 SIWE 流程；采用固定到期而非无限滚动续期，避免活跃会话永久有效。非目标：多设备会话管理、refresh token 轮换体验（记录为后续可能需要的技术债，不阻塞本轮交付）。
- 已登录状态再次点击钱包入口只打开账户菜单，不得重新申请 nonce 或触发 SIWE 签名。退出必须显式调用服务端吊销接口；仅清除 React 状态不能视为安全退出。

## 接口契约

- `GET /api/auth/nonce` 响应：`{ nonce, expiresAt }`。
- `POST /api/auth/verify` 请求体：`{ message, signature }`（`message` 为完整 SIWE 消息文本）；响应：`{ walletAddress }`，并通过 `Set-Cookie` 下发 httpOnly+Secure+SameSite=Lax 的 session cookie；失败（签名不符/nonce 过期或已用/地址格式非法）一律 401，不泄露具体校验失败在哪一步。
- `GET /api/auth/session`：使用 httpOnly Cookie 恢复登录状态；成功响应 `{ authenticated: true, walletAddress, chainId }`。`chainId` 来自服务端 SIWE 配置，是登录、托管和结算使用的权威交易链；前端不得为了展示该网络而在页面加载时自动连接钱包扩展。
- `DELETE /api/auth/session`：按 Cookie 中的不透明 `session_id` 吊销服务端会话，并用 `Max-Age=0` 覆盖 httpOnly Cookie；缺少或已吊销会话时幂等返回 204，存储故障时返回可重试 503 且不得伪装成已退出。
- `GET /api/agents/:id`（`[v5 新增]`，T-011 承接）请求：需携带有效 session；响应：Agent 档案字段（不含 `encrypted_secret`），仅归属该 `provider_wallet_address` 的 session 可读取，否则 403。

- `POST /api/agents` 请求体：`{ name, categoryId, capabilityDesc, tags[], pricingType, price, walletAddress, payoutWalletAddress, serviceEndpoint, integrationMode?, credentialSecret?, portfolioCases?, email? }`。新页面显式发送 `integrationMode: "http_json"`；缺省值为 `aicp_hmac`，以兼容历史客户端且此时凭证仍必填。`email` 仅为旧客户端兼容字段。`portfolioCases` 最多 3 条；`walletAddress` 必须等于认证 actor，`payoutWalletAddress` 允许不同。
- `POST /api/agents/connection-test` 请求体：`{ serviceEndpoint, credentialSecret? }`；成功响应 `{ latencyMs }`，失败返回不含地址内部细节与凭证明文的统一错误结构。
- `PUT /api/agents/:id/credentials` 请求体：`{ credentialSecret }`；响应：`{ keyVersion, configured: true }`，不回显任何密钥相关字段。
- 错误响应复用 [[1.agent-protocol-contract]] 定义的统一错误码结构。

## 数据模型

- `agents(id PK, provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags TEXT[], pricing_type, price_amount, price_currency, service_endpoint, integration_mode, email NULL, status, created_at, updated_at)`；两个钱包字段均做结构校验，只有前者参与归属鉴权；`email` 是历史兼容列。
- `agent_credentials(agent_id PK FK, encrypted_secret, key_version, updated_at)`
- `agent_portfolio_cases(id PK, agent_id FK, title, summary, artifact_kind, preview_ref, category_id, tags TEXT[], created_at)`；只保存来源为 `agent_provided` 的材料，候选查询返回时才映射为公开来源标签。
- `audit_logs(id PK, actor_id, actor_type, action, target_type, target_id, before_summary JSONB, after_summary JSONB, created_at)`（平台共享表，凭证类字段禁止写入 `before_summary`/`after_summary`）
- `auth_nonces(nonce PK, expires_at, consumed_at NULL, created_at)`（`[v5 新增]`，平台共享表）
- `auth_sessions(session_id PK, wallet_address, expires_at, created_at)`（`[v5 新增]`，平台共享表）

## 安全考虑

- 遵循 AGENTS.md §9：凭证、完整钱包签名不得出现在日志；`audit_logs` 的 summary 字段生成逻辑需显式排除凭证字段，而不是事后脱敏。
- 连接测试必须阻止匿名调用、非 HTTP(S) 协议、生产私网地址、跨 origin 健康地址和 DNS rebinding；错误响应不回显已解析 IP、访问密钥或完整内部网络细节。
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
| 默认 Agent 接入 | 执行地址 + 可选访问密钥（选中）vs 强制安装 SDK | 已完成 Agent 通常已有 HTTP API；默认快速接入只要求稳定 JSON 契约，把状态与重试复杂度留在平台内部。SDK/HMAC 保留为高级兼容方式，不增加普通上架心智负担 |
