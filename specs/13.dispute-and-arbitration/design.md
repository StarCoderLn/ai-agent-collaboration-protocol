# 争议与人工仲裁 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-23 | v2   | 落地持久化角色校验、可恢复资金执行、完整争议审计与 SSE 刷新恢复 |

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

### 模块 4: 审计

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
- 内部：链上执行完成回调将 `decision.status` 更新为 `executed`（由 [[6.escrow-sync-and-wallet]] 的确认流程触发）。

## 数据模型

- `disputes(id PK, task_id FK, initiator_id, reason, status, evidence_deadline, created_at)`
- `dispute_evidence(id PK, dispute_id FK, submitter_id, content_ref, submitted_at)`
- `arbitration_decisions(id PK, dispute_id FK, arbitrator_id, decision_type, payout_breakdown JSONB, reasoning, decided_at, status, tx_hash, executed_at)`

## 安全考虑

- 仲裁决定接口的权限校验是本 feature 的核心风险点，需要与 [[14.ops-backend-and-metrics]] 的角色体系联调验证，不允许普通运营账号越权仲裁（如果角色设计上区分仲裁员与普通运营）。
- 争议相关的证据可能包含敏感信息，访问权限仅限争议双方与授权仲裁员。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：争议相关状态使用 error（红）语义，但克制使用（不加动画/强提示音等），符合规范「专业、克制」的整体基调。仲裁决定的「处理中（decided）」与「已完成（executed）」两个阶段必须用不同图标和文案区分，不能仅凭状态文字的细微差别让用户误判资金已到账（对应 design.md 模块 3 的两阶段展示要求）。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 资金冻结机制 | 任务状态机「争议中」作为前置校验条件（选中）vs 独立的冻结标记表 | 复用已有状态机比新增一套冻结标记更符合「同一业务规则集中在一个权威位置」，且状态机已经是所有资金操作前必须检查的路径 |
| 执行状态展示 | `decided`/`executed` 两阶段（选中）vs 决定即视为完成 | 直接展示「已完成」会在链上交易尚未确认时误导用户，违反 PRD 明确的验收标准（AC-006 / F-006） |
