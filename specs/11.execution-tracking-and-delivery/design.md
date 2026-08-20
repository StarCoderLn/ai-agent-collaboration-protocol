# 执行追踪与结果交付 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 明确验收 API 调用 `4.CalculatePlatformFee()` 而非自行实现费率逻辑 |
| 2026-08-20 | v3   | 模块 2 超时检测范围扩大到「待匹配、待接单、执行中」三个状态，修正早期状态 deadline 过期无人检测的漏洞 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，状态上报与超时检测）、交易/业务服务（结果提交与验收 API）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 执行状态上报与防倒退

**涉及层及关键设计:**

- Agent 上报的每个状态变化都通过 [[10.notification-and-sync]] 的 `EmitTaskEvent()` 写入 `task_events`，携带 Agent 本地生成的 `reported_at` 与平台生成的 `status_version`。
- 防倒退规则：只有当新事件代表的状态在任务状态机中「晚于或等于」当前记录的最新状态时才接受；判断逻辑集中在 `TransitionTaskStatus()`（[[4.task-creation-and-preview]] 定义），本模块不重新实现状态先后判断逻辑。

### 模块 2: 超时检测

**涉及层及关键设计:**

- `[v3]` 定时任务扫描 `deadline < now()` 且状态为「待匹配」「待接单」或「执行中」（`WHERE status IN (...)`，不再只查「执行中」）的任务，触发向「已超时」的状态迁移，写入事件并停止后续自动重试逻辑（不再向 Agent 发送新的执行相关请求、不再触发新的匹配/派发）。
- 三个状态共用同一条迁移逻辑（`TransitionTaskStatus(taskId, DeadlineExpired, system)`），不因来源状态不同而分支处理——已超时之后的下游处理（争议或退款）不关心任务是从哪个状态超时的，不需要在这里保留来源信息之外的额外逻辑。
- 「待托管」不在扫描范围内：该阶段任务尚未完成资金托管确认，其失败恢复路径由 [[6.escrow-sync-and-wallet]] 的交易失败/超时机制单独处理，两者关注点不同（一个是"钱有没有托管成功"，一个是"任务有没有在承诺时间内交付"），混在一个扫描器里会让两条不相关的失败语义纠缠在一起。
- 「已超时」之后的处理（争议或退款）由 [[13.dispute-and-arbitration]] 与 [[6.escrow-sync-and-wallet]] 承接，本模块只负责状态迁移触发，不涉及资金操作。

### 模块 3: 结果提交与版本管理

**涉及层及关键设计:**

- `task_results` 表记录每次提交，`submission_batch` 标识同一次提交的 1~3 个结果为一组，`is_latest` 标记当前生效批次，历史批次保留不删除。
- 提交时校验数量（1~3）、必填字段（摘要、正文或文件引用、生成时间）、文件类型与大小；不合规的提交整体拒绝，不允许部分结果进入「待验收」。

### 模块 4: 验收与返工

**涉及层及关键设计:**

- 验收 API 计算结算金额与手续费（`[v2]` 调用 [[4.task-creation-and-preview]] 的 `CalculatePlatformFee()`，不重新实现一遍费率逻辑），展示后由发布者确认，确认后触发状态迁移到「待结算」，实际链上结算由 [[6.escrow-sync-and-wallet]] 承接（授权 `release` 调用，`feeAmount` 参数即此处计算结果）。
- 返工请求记录在 `rework_requests` 表，`attempt_no` 递增，超过 `rework_config.max_attempts` 时拒绝；返工触发任务从「待验收」回到「执行中」。

## 接口契约

- `POST /agent-callback/tasks/:id/status`：Agent 上报执行状态（签名验证，复用协议 1）。
- `POST /agent-callback/tasks/:id/results`：Agent 提交结果批次。
- `GET /api/tasks/:id/results`：发布者查看候选结果列表（含历史版本标识）。
- `POST /api/tasks/:id/accept`：发布者验收，请求体 `{ resultId }`，响应含结算金额与手续费明细。
- `POST /api/tasks/:id/rework`：发布者要求返工，超限返回 `REWORK_LIMIT_EXCEEDED`。

## 数据模型

- `task_results(id PK, task_id FK, submission_batch, summary, body_or_file_ref, generated_at, note, is_latest, created_at)`
- `rework_requests(id PK, task_id FK, attempt_no, reason, created_at)`
- `rework_config(task_id FK 可为空表示全局默认, max_attempts, extra_time_ratio)`

## 安全考虑

- 文件引用需先经过类型白名单与大小上限校验（复用 [[4.task-creation-and-preview]] 附件校验规则，避免规则重复定义）。
- Agent 状态上报和结果提交均需签名验证，防止非授权方伪造执行状态或结果。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：执行进度使用时间线（timeline）组件展示状态变化序列；结果版本标识使用中性 tag（「最新版本」高亮，历史版本弱化但可查看）。验收页的结算金额与手续费使用等宽数字对齐展示，金额相关文案不使用装饰性字体。返工操作作为次要操作按钮，避免视觉上与「验收」（主要操作）等重。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 防倒退判断位置 | 复用统一状态机的先后关系判断（选中）vs 本模块独立实现时间戳比较 | 单纯比较时间戳无法应对 Agent 与平台时钟偏差；复用状态机的显式状态先后关系更可靠，且保持规则集中 |
| 结果版本管理 | 批次 + `is_latest` 标记（选中）vs 覆盖旧结果 | 覆盖会丢失历史提交记录，不满足「重复提交保留版本记录」的验收标准 |
