# Agent 钱包换绑 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（换绑请求、签名验证、通知、冷静期定时任务）、PostgreSQL、前端（wagmi/viem 发起签名）

## 功能模块设计

### 模块 1: 换绑请求与新钱包所有权验证

**涉及层及关键设计:**

- 平台生成一次性挑战消息（含 `agentId`、`newAddress`、随机 nonce、有效期），前端用新钱包发起标准 Ethereum 消息签名（`personal_sign` / EIP-191），后端用 `ethers`/`viem` 的签名恢复函数验证恢复出的地址与提交的 `newAddress` 一致。
- **明确不同于 [[1.agent-protocol-contract]] 的签名机制**：协议层的 `Sign()`/`VerifySignature()` 是平台与 Agent 服务端之间的 HMAC 对称签名（用共享密钥），而这里是终端用户钱包的 ECDSA 非对称签名（标准 Web3 钱包认证模式），两者场景和算法都不同，不能直接复用协议层的签名函数，只是共享"挑战消息 + nonce 防重放"的设计思路。

### 模块 2: 站外通知与取消

**涉及层及关键设计:**

- 通知发送到账号注册邮箱（不通过站内消息/APP 推送），附带 `cancel_token`（一次性、无需登录即可访问的取消链接），这是安全设计的核心：如果账号本身被盗，攻击者能看到所有站内通知，但通常拿不到独立的邮箱访问权限。
- 取消操作本身不需要额外身份验证——拥有这条链接（即拥有邮箱访问权）本身就是身份证明，与常见的"邮箱验证链接"模式一致。

### 模块 3: 冷静期与到期生效

**涉及层及关键设计:**

- `wallet_rebind_requests.status`：`pending_verification`（等待签名验证）→ `cooling_down`（冷静期中）→ `completed`（已生效）或 `cancelled`（已取消，终态）。
- 定时任务扫描 `cooling_down` 且 `cooldown_deadline` 已过的请求，更新 `agents.wallet_address` 为新地址，状态转 `completed`，写审计日志；任务本身按请求 ID 幂等（重复扫描到已 `completed` 的记录直接跳过）。

### 模块 4: 结算隔离

**涉及层及关键设计:**

- [[6.escrow-sync-and-wallet]]、[[11.execution-tracking-and-delivery]] 中涉及支付目的地的逻辑一律读取 `agents.wallet_address` 这个权威字段的**当前值**，不感知是否存在进行中的换绑请求——因为 `agents.wallet_address` 在冷静期内本来就还没变，天然保证了"冷静期内结算走旧地址"，不需要额外的隔离逻辑或特殊分支，这是状态设计上的自然结果，而不是靠业务代码里加 if 判断实现的。

### 模块 5: 前端

**涉及层及关键设计:**

- 发起换绑页：连接新钱包 → 展示挑战消息 → 触发钱包签名 → 提交验证。
- 邮件取消落地页：无需登录，展示"是否为你本人操作"的确认信息与一键取消按钮。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：换绑是高风险操作，走「高风险操作二次确认」交互模式（复用 [[14.ops-backend-and-metrics]] 定义的二次确认组件思路，但这里是终端用户场景，不是运营后台）；冷静期状态用 warning（琥珀）展示"待生效"，明确的倒计时或到期时间用等宽数字对齐显示；取消按钮使用 error 语义强调"这是一个中断危险操作的动作"。

## 接口契约

- `POST /api/agents/:id/wallet-rebind/challenge`：生成挑战消息，返回 `{ challengeId, message, expiresAt }`。
- `POST /api/agents/:id/wallet-rebind`：提交 `{ challengeId, newAddress, signature }`，验证通过后创建 `cooling_down` 状态的请求，触发站外通知。
- `GET /api/wallet-rebind/cancel?token=`：无需登录的取消端点，命中有效 `cancel_token` 则将请求状态转 `cancelled`。

## 数据模型

- `wallet_rebind_requests(id PK, agent_id FK, current_address, requested_address, challenge_nonce, ownership_signature, cancel_token, status, notified_at, cooldown_deadline, created_at, completed_at)`
- 状态迁移写入 [[2.agent-registration]] 定义的共享 `audit_logs` 表。

## 安全考虑

- `cancel_token` 需要高熵随机值、一次性使用（使用后立即失效），且不作为 URL 之外的任何地方展示或记录。
- 同一 Agent 同时只允许一个进行中（`pending_verification`/`cooling_down`）的换绑请求，防止并发请求造成状态混乱或被用来掩盖真实的恶意请求。
- 挑战消息必须有有效期（如 10 分钟），过期的挑战不可再用于验证签名，防止旧挑战被重放。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 通知渠道 | 站外邮箱（选中）vs 站内消息 | 站内消息在账号被盗场景下形同虚设，站外渠道是这套防护机制成立的前提，业界（交易所提现地址变更）也统一采用站外渠道 |
| 冷静期期间的地址权威值 | `agents.wallet_address` 不提前变更，结算天然读旧值（选中）vs 提前变更但加"待生效"标记、结算逻辑加判断 | 前者不需要下游任何模块感知换绑存在，是更深的接口（下游模块不知道换绑这回事也能正确工作）；后者会让结算逻辑背上额外的分支和跨模块知识 |
