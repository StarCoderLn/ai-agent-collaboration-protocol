# 争议与 DAO 仲裁 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-23 | v2   | 落地持久化角色校验、可恢复资金执行、完整争议审计与 SSE 刷新恢复 |
| 2026-09-02 | v3   | 增加 YD 链上成员资格、可复现无冲突分案、DAO 多数裁决和原子多 Agent 资金执行 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（争议与仲裁 API）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 争议创建与资金冻结

**涉及层及关键设计:**

- 争议创建时，任务主状态机（[[4.task-creation-and-preview]] 权威定义）迁移到「争议中」，该状态是 [[6.escrow-sync-and-wallet]] 结算/退款触发前必须校验的前置条件之一：任何非仲裁流程发起的 `release`/`refund` 调用在任务处于「争议中」时一律拒绝，从状态机层面而非业务逻辑散点校验实现资金冻结。

### 模块 2: 证据提交

**涉及层及关键设计:**

- `dispute_evidence` 记录双方提交，校验提交时间不超过 `evidence_deadline`；证据内容（文件引用）复用 [[4.task-creation-and-preview]] 的附件类型/大小校验规则，不重复实现。

### 模块 3: 仲裁决定与执行

**涉及层及关键设计:**

- 仲裁决定 API 要求调用者具备仲裁员角色权限（复用 [[14.ops-backend-and-metrics]] 定义的角色权限体系，本 feature 只声明所需权限点）。
- Feature 14 延后期间，`platform_actor_roles` 已由本 feature 建表并以
  `role='arbitrator'` 作为服务端权威权限；Feature 14 后续只扩展角色种类与运营入口，
  不替换这里的鉴权边界。
- 决定记录 `decision`（`release` / `partial_release` / `refund`）以及释放、退款、平台费、
  Agent 实收金额，决定生成后触发 [[6.escrow-sync-and-wallet]] 的授权资金调用。界面状态
  分为 `decided`（决定已记录）、`submitted`（交易已广播、等待确认）和 `executed`
  （链上已确认）；只有 `executed` 才展示「已完成」。
- 实际执行细分为 `decided → submitted → executed`：决定事务创建
  `escrow_execution_jobs(source='arbitration')`；worker 先持久化签名交易再广播，失败按上限
  重试或进入死信；链事件同步核对交易哈希、收款地址和金额后才解除冻结并推进任务终态。

### 模块 4: YD DAO 成员与分案 `[v3 新增]`

- `ArbitrationDAO` 只负责最适合公开强制执行的 YD 锁仓、最低门槛和退出冷静期；争议正文、分案和投票保留在受权限保护的业务数据库，避免把敏感任务内容公开上链。
- 产品 YD 与本地 DAO `TestYD` 使用独立配置：工作台始终按 Sepolia 产品合约读取用户资产；Anvil DAO 通过 `ARBITRATION_DAO_YD_TOKEN_ADDRESS` 绑定本地夹具。公共测试网部署时 DAO 再绑定同一产品 YD，禁止本地启动器覆盖资产目录。
- 前端提交的交易哈希只是索引。服务端核对成功回执、目标 DAO 合约、事件中的成员钱包、确认数，并在回执区块读取 `membershipOf`、`isEligible`、`minimumStake` 与 `ydToken` 后才更新成员镜像。
- 分案种子创建案件时一次固化，候选按 `keccak256(seed, actor)` 稳定排序。查询统一排除发布者、全部已接单 Agent 的 provider 与 payout 钱包；不足配置人数时保持 `awaiting_panel`。
- 当前页面完成质押、退出、取消退出或领取交易后会立即同步服务端。生产上线仍需 DAO 事件索引器或分案前 latest-chain revalidation，覆盖用户绕过页面直接调用退出合约造成的短暂镜像滞后。

### 模块 5: DAO 投票与统一资金计划 `[v3 新增]`

- 投票事务锁定仲裁轮次，数据库唯一键阻止同一成员重复投票；只有同一裁决类型达到 quorum 才形成多数，意见分散时继续等待。
- DAO 和平台仲裁共同调用 `buildArbitrationSettlementPlan()`：一次读取工作流、冻结报价、最新制品和争议证据，按裁决释放总额比例分配，固化 `decisionHash`、`evidenceRoot` 与 `settlementManifestHash` 后创建 outbox。
- 全额退款创建 `dispute_refund`；部分或全部支付创建 `workflow_settle`。worker 广播后仍保持争议冻结，链同步逐项核对事件与 outbox，确认后才同时更新任务、托管、争议和裁决终态。

### 模块 6: 审计

**涉及层及关键设计:**

- 仲裁决定、证据提交、状态迁移全部写入共享 `audit_logs` 表（[[2.agent-registration]] 定义），保证与平台其余高风险操作使用同一套审计基础设施，而不是为仲裁单独建一套日志体系。
- 广播、执行失败和最终链确认均额外以 `target_type='dispute'` 写审计，因此按 disputeId
  可查询从发起、证据、决定到资金结果的完整轨迹，而不必跨 task 审计猜测关联关系。
- 任务详情首次建立 SSE 时从事件游标 0 回放历史事件；`task.dispute_opened` payload 中的
  disputeId 可在页面刷新后恢复，随后再按权限读取争议卷宗。

## 接口契约

- `POST /api/tasks/:id/disputes`：发起争议，请求体 `{ reason, initialEvidence? }`。
- `POST /api/disputes/:id/evidence`：提交证据（双方均可调用，校验截止时间）。
- `GET /api/disputes/:id`：查询争议状态、证据、（仲裁后的）决定。
- `POST /api/disputes/:id/decision`：仲裁员做出决定（需要仲裁员角色权限），响应含 `decisionId`，状态为 `decided`。
- `GET /api/dao`：返回当前钱包的链上配置、已同步成员资格和被分配案件。
- `POST /api/dao/membership/sync`：提交成员操作交易哈希，服务端完成链上核验后同步资格。
- `POST /api/dao/rounds/:id/votes`：仅当前仲裁小组成员提交投票，达到多数时原子生成裁决与资金 outbox。
- 内部：链上执行完成回调将 `decision.status` 更新为 `executed`（由 [[6.escrow-sync-and-wallet]] 的确认流程触发）。

## 数据模型

- `disputes(id PK, task_id FK, initiator_id, reason, status, evidence_deadline, created_at)`
- `dispute_evidence(id PK, dispute_id FK, submitter_id, content_ref, submitted_at)`
- `arbitration_decisions(id PK, dispute_id FK, arbitrator_id, decision_type, payout_breakdown JSONB, reasoning, decided_at, status, tx_hash, executed_at)`
- `dao_memberships(actor_id PK, chain_id, contract_address, staked_amount_minor, eligible, exit_available_at, sync_tx_hash, sync_block_number)`
- `dao_arbitration_rounds(id PK, dispute_id UNIQUE, selection_seed, panel_size, quorum, voting_deadline, status)`
- `dao_arbitration_panel_members(round_id, actor_id, selection_order, selected_stake_minor)`
- `dao_arbitration_votes(id PK, round_id, actor_id, decision, release_basis_points, reasoning)`

## 安全考虑

- 仲裁决定接口的权限校验是本 feature 的核心风险点。当前以 `platform_actor_roles` 的持久化 `arbitrator` 角色为权威，不允许普通运营账号越权；Feature 14 后续只能复用该边界增加管理入口，不能另建一套角色判断。
- 争议相关的证据可能包含敏感信息，访问权限仅限争议双方与授权仲裁员。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：争议相关状态使用 error（红）语义，但克制使用（不加动画/强提示音等），符合规范「专业、克制」的整体基调。仲裁决定的「处理中（decided）」与「已完成（executed）」两个阶段必须用不同图标和文案区分，不能仅凭状态文字的细微差别让用户误判资金已到账（对应 design.md 模块 3 的两阶段展示要求）。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 资金冻结机制 | 任务状态机「争议中」作为前置校验条件（选中）vs 独立的冻结标记表 | 复用已有状态机比新增一套冻结标记更符合「同一业务规则集中在一个权威位置」，且状态机已经是所有资金操作前必须检查的路径 |
| 执行状态展示 | `decided`/`submitted`/`executed` 三阶段（选中）vs 决定即视为完成 | 单独记录已广播待确认状态，才能区分尚未提交与链上确认中；直接展示「已完成」会误导用户，违反 PRD 明确的验收标准（AC-003 / F-006） |
| DAO 链上边界 | 只把资格质押上链（选中）vs 证据和投票全文上链 | 质押需要公开可验证和不可伪造；任务证据可能含商业机密，全文上链不可删除且泄露隐私。链下投票保留审计记录，最终摘要随资金结果上链 |
| 多 Agent 仲裁分账 | 复用统一资金计划模块（选中）vs DAO/平台各自计算 | 单一权威算法保证两个入口的收款人、手续费、舍入和证据编码一致，避免争议结果取决于使用哪个仲裁入口 |
