# 派发与接单确认 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-31 | v2   | 新增托管前选择事务，正式 assignment 延后到资金确认并按 DAG 依赖创建 |
| 2026-08-31 | v3   | 选择事务支持托管意图前改选、报价修订事件和意图后锁定 |
| 2026-09-01 | v4   | 选择事务支持已证明未广播的失败 intent 改选，并同步修订 intent 金额 |
| 2026-09-01 | v5   | 未广播 prepared 状态的改选确认入口移入当前 Agent 区，确认后自动展开候选 |
| 2026-09-03 | v6   | 派发支持快速 HTTP JSON 同步产物，并以持久化结果恢复内部转交 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，权威实现）、AWS SQS（派发队列）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 原子占用分配

**涉及层及关键设计:**

- `task_assignments` 对单 Agent 任务保持任务级唯一约束，对正式工作流按 `workflow_node_id` 保证每个节点最多一条活跃分配；不同 DAG 节点可在依赖允许时并行执行，不被任务级锁错误串行化。
- 确认请求与自动分配走同一内部函数 `LockAssignment(taskId, agentId, actor)`，两者唯一区别是 `actor` 是「发布者」还是「系统（自动分配）」，避免两条并行实现导致行为不一致。
- 成交价只读取所选 `JobDistributionRecord.candidates[].quoteMinor` 冻结快照；匹配后 Agent 修改当前报价不会改变用户已经看到的成交条件。

### 模块 0: 托管前选择 `[v2 新增]`

**涉及层及关键设计:**

- `PgWorkflowSelectionRepository.select()` 在一个 PostgreSQL 事务中锁定 task、workflow run、node 和最新候选记录；校验发布者身份、`planning|awaiting_escrow`、节点可选状态及候选成员后，写入 `selected_agent_id`、`selection_record_id`、`agreed_amount_minor` 和候选记录的 `final_selection_agent_id`。
- 浏览器不提交价格。最后一个节点选定后，事务汇总所有节点报价、冻结 workflow run 总价并执行 `planning → awaiting_escrow`；部分选择、越权、非候选、损坏快照或重复进行中的请求均不得开放托管。
- 待托管改选保持任务状态不变，只更新目标节点并原子重算 `quoted_total_minor`、任务固定价和版本，写入 `candidate_reselected`、`task.workflow_quote_revised` 与替换审计。选择事务和 `prepareIntent()` 都先锁 task 行；无 intent 可直接改选，`failed + 无 deposit_tx_hash + 无 escrow_sync` 可改选并同步 intent 金额，其他 intent 状态拒绝。Deposit 登记还必须携带准备时金额，旧页面不能在改选后恢复旧报价。
- 托管确认后分发引擎优先读取带 `final_selection_agent_id` 的最新快照，并以 `system:selected` 创建 assignment。只有此刻才占用 Agent、发送协议请求；选人期间不调用第三方服务。

### 模块 2: SQS 派发

**涉及层及关键设计:**

- 分配成功后，Go 分发引擎向 SQS 投递派发消息，消息体含幂等键（`dispatch:{taskId}:{assignmentId}`），消费者处理前先走 [[1.agent-protocol-contract]] 的 `CheckAndReserve()` 去重。
- 消费者读取 Agent 的 `integration_mode`：`aicp_hmac` 向 `service_endpoint` 发起签名请求并等待同步确认或异步回调；`http_json` 使用可选 Bearer Token，要求同一次响应返回完整产物。两者共享同一已持久化派发正文和尝试记录。
- 快速响应由 `internal/quickagent` 解析器验证，并先写入 `dispatch_attempts.quick_result_payload`。处理器随后确认 assignment 并转交 Marketplace API；若转交返回暂时性 409，只重试内部转交，成功后写入 `quick_result_delivered_at`。恢复路径绝不重新调用 Agent，避免重复模型费用和非确定性结果。

### 模块 3: 接单确认与超时

**涉及层及关键设计:**

- Agent 的接单/拒单回调复用 [[1.agent-protocol-contract]] 的验签中间件，更新 `task_assignments.status`。
- 快速 Agent 无需单独回调接单：有效同步产物同时证明本次请求已被接受；平台在保存产物后执行接单确认。任务生命周期事件只为 HMAC Agent 创建 Webhook outbox。
- 定时任务扫描 `accept_by` 已过期且仍为 `pending_ack` 状态的分配，标记为 `accept_failed`；同一事务写入 `task_transition_outbox`，由 Marketplace API 幂等消费后通过权威任务状态机回到「待匹配」。原候选集合可重新选择，不强制重新执行匹配管道。

## 接口契约

- `POST /api/tasks/:id/workflow-nodes/:nodeId/assignments`：兼容现有前端入口；任务为 `planning` 时执行候选选择和报价冻结，托管后才进入正式 assignment 路径。请求体只含 `{ agentId }` 并要求幂等键。
- 内部：`LockAssignment(taskId, agentId, actor) (assignment, error)`。
- Agent 侧回调：`POST /agent-callback/assignments/:id/ack`（Agent 确认/拒绝），复用协议 1 的签名与幂等中间件。

## 数据模型

- `task_workflow_nodes(..., selected_agent_id, selection_record_id, agreed_amount_minor, status, version)` 保存托管前选择；`task_workflow_runs(..., quoted_total_minor, quote_confirmed_at)` 保存准确总价。
- `task_assignments(id PK, task_id FK, workflow_node_id FK, agent_id FK, distribution_record_id FK, agreed_amount_minor, status, version, assigned_by, assigned_at, accept_by, responded_at)`；工作流节点维度的活跃唯一约束防止重复占用。
- `dispatch_attempts(id PK, assignment_id FK, idempotency_key UNIQUE, protocol_request_id UNIQUE, status, attempt_no, error_code, next_attempt_at, quick_result_payload, quick_result_delivered_at)`。
- `task_transition_outbox` / `task_transition_inbox`：跨 Go 与 Marketplace API 的可重试、可恢复、幂等任务状态迁移。

## 安全考虑

- 候选确认接口需校验请求者为该任务的发布者，防止越权分配。
- Agent 回调复用协议层签名验证，防止伪造接单/拒单响应。
- 快速 Agent 的同步结果属于不可信输入，必须限制响应体大小、严格校验产物类型与数量，并拒绝尾随第二段 JSON；可选访问密钥不得写入日志。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：分配状态（待确认/已接单/被拒/超时）使用状态徽章组件，文字 + 图标 + 语义色三者结合（成功用绿、待处理用琥珀、失败/拒绝用红），不单独依赖颜色。关系图默认只保留每阶段已选 Agent，并以高亮流动虚线连接已冻结的阶段依赖；点击“重新选择”才展开该阶段冻结候选，取消或确认后重新收敛。若只生成了 `prepared` 托管参数且没有 Deposit 哈希或链事件，“重新选择”入口仍显示在当前 Agent 区；用户就地确认 MetaMask 没有待处理 Deposit 后，页面先把准备状态安全转为 `failed`，读取服务端权威状态成功后自动展开候选。托管操作位于关系图、阶段选择和最终报价之后。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 原子占用实现 | 数据库唯一部分索引 + 条件写入（选中）vs 应用层分布式锁 | 数据库约束是强一致的、经过验证的机制，避免引入额外的锁服务（Redis 分布式锁）及其自身的故障模式 |
