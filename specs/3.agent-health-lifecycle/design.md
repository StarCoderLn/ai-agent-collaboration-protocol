# Agent 健康检查与生命周期 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 模块 3 的审核触发来源明确为 [[15.agent-sandbox-admission]] 的清单判定结果 |
| 2026-08-20 | v3   | 模块 2 补充连续失败计数的精确规则（计入的错误类型、重置条件、统计对象） |
| 2026-08-20 | v4   | 新增自动恢复逻辑（模块 2）与提供者手动恢复接口（模块 3）；确定阈值/间隔默认值 |
| 2026-08-20 | v5   | 新增模块 4「受控上线期风险上限」，替换此前语义矛盾的「试运行风险上限」提法；`agent_status_config` 字段调整 |
| 2026-08-23 | v6   | 对齐 PLAN：Feature 15 延后期间使用有角色校验、理由必填和审计留痕的 MVP 人工审核入口，并补驳回终态 |
| 2026-08-31 | v7   | 受控上线期门禁改为 Agent 单次报价上限，与用户规划预算候选过滤解耦 |
| 2026-09-03 | v8   | 健康探测读取 `integration_mode`，支持默认快速 HTTP JSON 与历史 HMAC |
| 2026-09-04 | v9   | 移除临时人工审核 API 与页面，准入只接受 Feature 15 的自动评测证据 |
| 2026-09-04 | v10  | 冷启动门禁改读真实结算任务数；“新 Agent”与评分低样本不再复用同一状态 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，健康检查定时任务与状态机权威实现）、业务服务（提供者操作 API）、PostgreSQL、前端

## 功能模块设计

### 模块 1: Agent 状态机

**涉及层及关键设计:**

- 状态机权威实现放在 Go 分发引擎（而非业务服务），因为派发链路（feature 9）需要在同一进程内以强一致的方式读取最新状态做候选过滤，跨服务查询会引入不必要的网络往返和时序竞争。
- 显式状态：`pending_review`（自动验证中）→ `active`（可接单）→ `paused`（暂停，可人工或自动触发）→ `delisted`（下架，终态）。数据库枚举名称为兼容已发布迁移而保留，产品界面不展示“待审核”。
- 用可辨识联合表达状态转移事件（`ManualPause` / `AutoPauseHealthCheck` / `AdminApprove` / `ProviderDelist` / `AutoResumeHealthCheck` `[v4 新增]` / `ManualResume` `[v4 新增]`），非法转移在类型层面即不可表达，而不是靠 if 分支兜底。
- `[v4]` `paused` 状态携带 `pause_reason`（`health_check` / `manual`），记录在 `agents.pause_reason` 列（与 `agents.status` 同表，物理定义随 [[2.agent-registration]] 的 `agents` 表，语义归属本 feature）。这个字段是自动恢复能否触发、以及手动恢复接口是否放行的唯一依据：`AutoResumeHealthCheck` 只对 `pause_reason = health_check` 生效；`ManualResume` 只对 `pause_reason = manual` 生效，互不跨越，防止提供者绕过健康检查直接强行恢复一个还不健康的 Agent（对应 requirements.md AC-007）。

### 模块 2: 健康检查

**涉及层及关键设计:**

- Go 侧定时任务按 Agent 独立调度，调用其 `service_endpoint` 同域 `/healthz`。`aicp_hmac` 使用 AICP v1 签名；`http_json` 使用可选 Bearer Token。未知模式直接归类为协议不兼容，不能为了“尽量可用”静默发送无认证请求。两种模式继续复用同一超时分类和生命周期状态机。
- 检查结果写入 `agent_health_checks` 表（滚动保留最近 N 条），连续失败计数在应用层维护，达到阈值触发 `AutoPauseHealthCheck` 事件。
- 阈值、检查间隔均从配置表读取（非硬编码常量），便于产品在待确认数值敲定后直接调整而无需改代码。
- `[v3]` 连续失败计数的精确规则（`CountConsecutiveFailures()`，与 `Agent 内部错误`/真实任务失败严格隔离的判断逻辑集中在这一处，避免各调用方各自理解口径）：
  - **统计对象**：仅本模块发起的专门健康检查探测，不统计 [[9.dispatch-and-acceptance]]、[[11.execution-tracking-and-delivery]] 中产生的真实任务失败——这两类失败已经有各自的处理路径（换候选、评分、争议），不应该反过来触发健康检查的熔断，否则会让"健康检查"这个概念承担它不该承担的业务知识。
  - **计入范围**：只有 `AUTH_INVALID_SIGNATURE`/`AUTH_EXPIRED_TIMESTAMP`/`AUTH_REPLAYED_NONCE`（认证失败）、`PROTOCOL_VERSION_UNSUPPORTED`（协议不兼容）、`CONN_TIMEOUT`（连接超时）三类计入失败计数；`AGENT_INTERNAL_ERROR` 记录但不计数——它反映的是 Agent 业务逻辑的问题而非"联系不上/不遵守协议"，两者的根因和处置方式不同，混在一起数会让熔断阈值变得没有明确含义。
  - **重置规则**：任意一次健康检查返回成功，计数器立即归零；不是"最近 N 次里失败次数达标"的滑动窗口统计，是严格连续（中间插入一次成功即中断）。

```text
连续失败计数示例（阈值=3）：
超时 → 超时 → 超时           → 触发暂停（计数=3）
超时 → 超时 → 成功 → 超时    → 不触发（成功后计数器归零，之后重新计数=1）
超时 → 内部错误 → 超时 → 超时 → 不触发（内部错误不计数，实际连续失败=2）
```

- `[v4 新增]` 自动恢复（`CountConsecutiveSuccessesWhilePaused()`）：仅当 `agents.status = paused` 且 `pause_reason = health_check` 时才生效——`active` 状态的 Agent 不需要这个计数器（它们的失败计数器走上面的常规重置规则）。健康检查成功时，`success_count` 递增；一旦失败，`success_count` 清零（同样是严格连续，不是滑动窗口）；达到 `resume_success_threshold`（默认 2）时触发 `AutoResumeHealthCheck`，`success_count` 和失败计数器一并重置。
- MVP 默认值（已确认，见 requirements.md）：`consecutive_failure_threshold = 3`，`health_check_interval = 5 分钟`，`resume_success_threshold = 2`。恢复阈值刻意高于失败阈值，形成非对称的迟滞区间（hysteresis），防止 Agent 状态在健康边缘反复抖动时于 `active`/`paused` 之间快速跳变（flapping）——这个非对称设计参考了 AWS 负载均衡器"判定不健康"与"判定恢复健康"通常使用不同阈值的惯例。

```text
自动恢复计数示例（恢复阈值=2，此时 Agent 处于 paused/health_check）：
成功 → 成功                 → 触发恢复（计数=2）
成功 → 失败 → 成功           → 不触发（失败后计数器归零，之后重新计数=1）
```

### 模块 3: 自动准入与生命周期操作

**涉及层及关键设计:**

- [[15.agent-sandbox-admission]] 的 Worker 在三次试运行和自动评测通过后，直接通过内部调用提交 `AdminApprove{AdmissionDecisionID}`。`AdminApprove` 名称作为已发布领域事件兼容保留，但调用者固定是系统自动准入 Worker，不代表人工管理员审批。
- 状态机校验结构化准入决策 ID 并在同一事务写入 Agent 状态和审计日志。原 `/api/admin/agents` 审核队列、通过与驳回公网接口均已删除，避免形成绕过自动门禁的第二条路径。
- 提供者的暂停/下架操作同样走“发起迁移请求 → 状态机校验合法性 → 落库 → 审计”的统一路径，不区分“谁发起”对状态机内部逻辑的影响，只影响审计记录里的 `actor_type`。
- `[v4 新增]` 提供者恢复接口同样走这条统一路径，但 `TransitionAgentStatus` 在处理 `ManualResume` 事件时会额外校验 `pause_reason`：`pause_reason = manual` 才允许迁移到 `active`；`pause_reason = health_check` 时返回 `RESUME_REQUIRES_HEALTH_RECOVERY` 错误码，而不是把这条校验散落到 API 层——校验逻辑集中在状态机内部，任何未来新增的恢复入口（例如运营后台的强制恢复）都会自动受到同一条规则约束。

## 接口契约

- 内部接口（Go 分发引擎）：`TransitionAgentStatus(agentId, event, actor) (newStatus, error)`，非法迁移返回 `INVALID_STATE_TRANSITION` 错误码。
- 自动准入内部调用由 [[15.agent-sandbox-admission]] 持有，不提供公网人工通过或驳回接口。
- `POST /api/agents/:id/pause` / `POST /api/agents/:id/delist`：提供者操作。
- `POST /api/agents/:id/resume` `[v4 新增]`：提供者恢复操作，仅 `pause_reason = manual` 时成功；`pause_reason = health_check` 时返回 `RESUME_REQUIRES_HEALTH_RECOVERY`（提示"等待自动恢复或联系运营"）。

### 模块 4: 冷启动风险上限与新 Agent 标识 `[v10 修订]`

**涉及层及关键设计:**

- 本模块描述两种不同事实：`isNew = settledTaskCount == 0` 只控制用户看到的“新 Agent”标识；`isColdStartRiskLimited = settledTaskCount < probationCompletedTaskThreshold` 控制单次报价风险。首个成功结算移除标识，默认第 3 个成功结算解除风控。
- `settledTaskCount` 只统计 `task_assignments.status = accepted` 且任务最终为 `settled` 的记录。沙箱准入、仅接单、执行失败、退款、超时和未完成结算均不计入，保证“成功”对应完整资金闭环。
- 两个状态均在查询时由历史事实派生，不在 `agents` 表保存易失真的布尔字段。解除阈值存于 `agent_status_config.probation_completed_task_threshold`（默认 3），目录 API 与 Go 匹配引擎读取同一权威配置。
- 冷启动期间的报价上限仍为平台历史成交金额分布第 30 百分位数，由 `probation_budget_cap_percentile` 配置。[[7.task-visibility-and-mode]] 的 `ValidateHardConstraints()` 比较 Agent 自身报价，不比较发布者预算偏好。
- [[12.scoring-system]] 的评分样本量和 `priorWeight` 继续决定评分置信度，但不再决定“新 Agent”或冷启动报价限制。这样用户未评分不会阻止已经稳定交付的 Agent 结束冷启动。

## 数据模型

- `agents.status`（枚举，权威字段，位于 [[2.agent-registration]] 定义的 `agents` 表）
- `agents.pause_reason` `[v4 新增]`（枚举 `health_check` / `manual` / 空，仅 `status = paused` 时有意义，同表同物理位置）
- `agent_health_checks(id PK, agent_id FK, result_code, counted_toward_failure BOOL, checked_at)`（`[v3]` 新增 `counted_toward_failure`：即使 `AGENT_INTERNAL_ERROR` 不计入连续失败计数，仍要落库以便运营排查趋势，只是不参与熔断判断，这个字段让"记录了什么"和"算不算失败"这两件事在数据层面就分开，不用每次查询都重新推导）
- `agent_status_config(agent_id FK, consecutive_failure_threshold, resume_success_threshold, health_check_interval_seconds, probation_budget_cap_percentile, probation_completed_task_threshold)`；两个冷启动配置分别决定报价上限分位数和解除所需真实结算任务数（默认 3）。
- 状态迁移统一写入 [[2.agent-registration]] 定义的共享 `audit_logs` 表。

## 安全考虑

- 自动准入状态迁移只接受内部服务认证，并要求结构化 `AdmissionDecisionID`；不能用客户端自报身份或自由文本理由替代。
- 自动暂停事件的触发者记录为系统账户，与人工操作在审计日志中可区分，避免运营误以为是人工操作。
- `[v4]` 提供者无法通过任何接口把一个 `pause_reason = health_check` 的 Agent 强行恢复为 `active`——这条校验在状态机内部而非 API 层实现（见模块 3），保证即使未来新增别的恢复入口也不会绕过。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`（Amethyst Intelligence 视觉系统）：`可接单` 用 success（绿）、`自动验证中` 用紫色动态进度、`验证未通过`/`暂停` 用 warning、`下架` 用中性色、健康失败用 error。“新 Agent”仅在零真实结算时使用轻量琥珀徽标；公开详情不展示“受控上线”、先验权重或分位数等内部术语。提供者控制台以弱提示展示 `已完成数/解除阈值`，不使用醒目的风险警告卡。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 状态机权威位置 | Go 分发引擎（选中）vs 业务服务 | 派发链路在同一进程读取状态可避免跨服务实时查询的延迟和一致性问题，符合“状态转换由后端单一权威模块维护”的项目不变量 |
| 阈值与风险上限来源 | 可配置表（选中）vs 代码常量 | PRD 明确标注这两个数值待产品确认，写入配置表可在不改代码的情况下按产品决策调整 |
| `[v3]` 连续失败计入范围 | 排除 `AGENT_INTERNAL_ERROR`（选中）vs 四类错误一视同仁 | 认证失败/协议不兼容/连接超时反映"平台联系不上或 Agent 不遵守协议"，是客观的连通性问题；`Agent 内部错误`反映的是业务逻辑质量问题，应由评分和试运行机制治理，混入同一熔断计数会让阈值失去明确含义，也可能因为 Agent 处理某类任务时偶发报错而被错误地整体停摆 |
| `[v4]` 恢复阈值与失败阈值是否对称 | 不对称，恢复阈值（2）高于失败阈值（3）不是直接相等，且恢复本身走独立计数器（选中）vs 恢复用与失败相同的单次成功即触发 | 单次成功即恢复会在 Agent 处于故障边缘时造成暂停/恢复快速交替（flapping），候选列表和已生成的匹配结果会跟着抖动；多一次确认的成本很低，换来的稳定性收益更高 |
| `[v4]` 提供者能否强制恢复健康检查暂停的 Agent | 不能，状态机内部拒绝（选中）vs 允许提供者强制恢复但风险自担 | 健康检查暂停的意义就是"平台联系不上/协议不合规"，允许绕过等于让这道防线形同虚设；提供者真正想恢复的路径是修好 Agent 让健康检查通过，而不是在没修好的情况下继续接单 |
| `[v10]` 新标识与风控是否共用条件 | 拆分（选中）vs 继续复用评分样本阈值 | “是否有过成功交付”“资金风险是否已有足够样本”“评分是否稳定”是三类事实；继续复用 `priorWeight=20` 会让展示、资金和评分互相泄漏业务知识 |
| `[v10]` 冷启动解除条件 | 3 个真实结算任务（选中）vs 首次成功即全部解除 vs 20 份评分 | 首次成功足以去掉“新”标识，但不足以完全证明稳定性；3 个完整资金闭环兼顾进入门槛和风控，20 份评分则会显著延长冷启动且受用户是否评分影响 |
