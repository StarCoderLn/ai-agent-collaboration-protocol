# 派发与接单确认 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，权威实现）、AWS SQS（派发队列）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 原子占用分配

**涉及层及关键设计:**

- `task_assignments` 表对 `(task_id)` 建唯一部分索引（`WHERE status = 'active'`），确认候选的写入使用 `INSERT ... ON CONFLICT DO NOTHING` 或等效的条件更新，数据库层面保证同一任务最多一条活跃分配记录，不依赖应用层加锁。
- 确认请求与自动分配走同一内部函数 `LockAssignment(taskId, agentId, actor)`，两者唯一区别是 `actor` 是「发布者」还是「系统（自动分配）」，避免两条并行实现导致行为不一致。

### 模块 2: SQS 派发

**涉及层及关键设计:**

- 分配成功后，Go 分发引擎向 SQS 投递派发消息，消息体含幂等键（`dispatch:{taskId}:{assignmentId}`），消费者处理前先走 [[1.agent-protocol-contract]] 的 `CheckAndReserve()` 去重。
- 消费者向 Agent 的 `service_endpoint` 发起签名请求（复用 `Sign()`），并等待 Agent 的同步确认响应或异步回调（协议允许两种模式，具体取决于 Agent 实现，[[1.agent-protocol-contract]] 已定义超时分类）。

### 模块 3: 接单确认与超时

**涉及层及关键设计:**

- Agent 的接单/拒单回调复用 [[1.agent-protocol-contract]] 的验签中间件，更新 `task_assignments.status`。
- 定时任务扫描 `accept_deadline` 已过期且仍为 `pending_ack` 状态的分配，标记为 `accept_failed`，触发任务状态回到「待匹配」，并将候选集合标记为可重新选择（不强制重新执行匹配管道，除非发布者显式请求 `POST /api/tasks/:id/rematch`）。

## 接口契约

- `POST /api/tasks/:id/assignments`：发布者确认候选，请求体 `{ agentId }`，冲突时返回 `ASSIGNMENT_ALREADY_LOCKED`。
- 内部：`LockAssignment(taskId, agentId, actor) (assignment, error)`。
- Agent 侧回调：`POST /agent-callback/assignments/:id/ack`（Agent 确认/拒绝），复用协议 1 的签名与幂等中间件。

## 数据模型

- `task_assignments(id PK, task_id FK, agent_id FK, status, version, assigned_by, assigned_at, accept_deadline, responded_at)`，唯一部分索引 `(task_id) WHERE status = 'active'`。
- `dispatch_attempts(id PK, task_id FK, assignment_id FK, attempt_no, error_message, dispatched_at)`。

## 安全考虑

- 候选确认接口需校验请求者为该任务的发布者，防止越权分配。
- Agent 回调复用协议层签名验证，防止伪造接单/拒单响应。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：分配状态（待确认/已接单/被拒/超时）使用状态徽章组件，文字 + 图标 + 语义色三者结合（成功用绿、待处理用琥珀、失败/拒绝用红），不单独依赖颜色。「任务已被分配」等并发冲突提示使用非阻断式提示（inline alert），不打断用户已完成的其他操作。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 原子占用实现 | 数据库唯一部分索引 + 条件写入（选中）vs 应用层分布式锁 | 数据库约束是强一致的、经过验证的机制，避免引入额外的锁服务（Redis 分布式锁）及其自身的故障模式 |
