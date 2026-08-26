# 通知与状态同步 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，事件生产与 Webhook 投递）、PostgreSQL（事件日志）、前端（SSE 客户端）

## 功能模块设计

### 模块 1: 事件日志（单一事实来源）

**涉及层及关键设计:**

- `task_events` 表是任务状态变化的唯一事实来源：任何模块（派发、执行追踪、验收、争议）触发状态变化时都写入一条事件，`status_version` 单调递增（按任务维度）。
- SSE 推送和 Webhook 通知都从这张表读取，不各自维护独立的事件缓冲，避免两条通道的事件顺序或内容不一致。

### 模块 2: Webhook 投递与死信队列

**涉及层及关键设计:**

- 投递复用 [[1.agent-protocol-contract]] 定义的重试分类：`CONN_TIMEOUT` 走指数退避，达到上限（默认 5 次）后记录进入 `webhook_deliveries` 表的 `dead_letter` 状态并告警。
- 每次投递尝试记录 `attempt_no`、`error_message`，供运营查询（[[14.ops-backend-and-metrics]] 复用此表）。

### 模块 3: SSE 推送与断线续传

**涉及层及关键设计:**

- 客户端连接时携带 `Last-Event-ID`（固定使用 `task_events.id` 全局事件 ID），服务端只推送该游标之后的事件；事件体另带任务维度单调递增的 `status_version`。断线重连不需要额外的会话状态。
- 降级方案：SSE 不可用时前端切换为轮询 `GET /api/tasks/:id/status`（即模块 4 的补拉接口），复用同一份状态读取逻辑，避免两套查询实现。
- 浏览器只为发布者正式任务建立事件流；网络错误用低干扰文字提示已经切换补拉，不把传输中断误画成任务执行失败。相同事件 ID 在进入时间线前去重，即使异常重复投递携带了不同事件名也只接收一次。

### 模块 4: 状态补拉

**涉及层及关键设计:**

- `GET /api/tasks/:id/status` 直接从任务当前状态表读取（不依赖事件日志重放），保证即使事件通道完全失败，业务状态仍可被独立查询到真实值。
- 补拉覆盖草稿、待托管、匹配、待接单、执行、验收和结算等全部任务阶段；尚无 `task_execution_state` 行时返回真实任务状态并以 `progress=0` 表达尚未开始执行。

## 接口契约

- 内部：`EmitTaskEvent(taskId, eventType, payload) event`（写入 `task_events`，`status_version` 自动递增）。
- `GET /api/tasks/:id/events/stream`（SSE，支持 `Last-Event-ID`）。
- `GET /api/tasks/:id/status`（补拉/轮询降级接口）。
- Agent 侧 Webhook：`POST {agent.serviceEndpoint}/webhook`，签名复用 [[1.agent-protocol-contract]] 的 `Sign()`。

## 数据模型

- `task_events(id PK, task_id FK, event_type, status_version, payload JSONB, created_at)`，`(task_id, status_version)` 唯一约束。
- `webhook_deliveries(id PK, task_id FK, agent_id FK, attempt_no, status, error_message, delivered_at)`。

## 安全考虑

- SSE 端点需校验请求者对该任务的访问权限（复用 [[7.task-visibility-and-mode]] 的可见性规则），不允许通过事件流绕过私密任务的访问控制。
- Webhook 投递失败信息在运营查询接口中展示，需脱敏内部服务地址等敏感配置。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：SSE 断线/降级为轮询时用次要文字色（`on-surface-variant`）展示低干扰提示，不使用 error 红色（这是网络状态，不是失败结果）。补拉/重试类操作使用次要按钮样式，避免与主要业务操作（如验收、确认候选）抢视觉焦点。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 事件来源 | 单一 `task_events` 表（选中）vs SSE/Webhook 各自独立事件缓冲 | 单一事实来源避免两条通知通道出现事件顺序或内容不一致，符合「同一业务规则只保留一个权威位置」 |
| 断线续传机制 | 基于单调递增 `status_version` 的游标（选中）vs 服务端维护连接会话状态 | 游标方式无状态、可水平扩展，且天然支持从任意断点续传，不需要额外的会话存储 |
