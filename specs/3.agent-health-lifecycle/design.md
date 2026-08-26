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

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，健康检查定时任务与状态机权威实现）、交易/业务服务（Next.js + AWS Lambda，运营审核 API 与提供者操作 API）、PostgreSQL、前端

## 功能模块设计

### 模块 1: Agent 状态机

**涉及层及关键设计:**

- 状态机权威实现放在 Go 分发引擎（而非业务服务），因为派发链路（feature 9）需要在同一进程内以强一致的方式读取最新状态做候选过滤，跨服务查询会引入不必要的网络往返和时序竞争。
- 显式状态：`pending_review`（待审核/试运行）→ `active`（可接单）→ `paused`（暂停，可人工或自动触发）→ `delisted`（下架，终态）。
- 用可辨识联合表达状态转移事件（`ManualPause` / `AutoPauseHealthCheck` / `AdminApprove` / `ProviderDelist` / `AutoResumeHealthCheck` `[v4 新增]` / `ManualResume` `[v4 新增]`），非法转移在类型层面即不可表达，而不是靠 if 分支兜底。
- `[v4]` `paused` 状态携带 `pause_reason`（`health_check` / `manual`），记录在 `agents.pause_reason` 列（与 `agents.status` 同表，物理定义随 [[2.agent-registration]] 的 `agents` 表，语义归属本 feature）。这个字段是自动恢复能否触发、以及手动恢复接口是否放行的唯一依据：`AutoResumeHealthCheck` 只对 `pause_reason = health_check` 生效；`ManualResume` 只对 `pause_reason = manual` 生效，互不跨越，防止提供者绕过健康检查直接强行恢复一个还不健康的 Agent（对应 requirements.md AC-007）。

### 模块 2: 健康检查

**涉及层及关键设计:**

- Go 侧定时任务按 Agent 独立调度，调用其 `service_endpoint` 的健康检查端点，复用 [[1.agent-protocol-contract]] 的签名与超时分类。
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

### 模块 3: 运营审核与生命周期操作

**涉及层及关键设计:**

- 审核 API 部署在业务服务（Next.js + AWS Lambda），审核通过后通过内部调用（非公开 API）通知 Go 分发引擎更新状态缓存，状态权威数据仍在 Go 侧管理的表中，业务服务只是发起状态迁移请求。
- `[v6]` `specs/PLAN.md` 已将 [[15.agent-sandbox-admission]] 延后至 P5。当前 MVP 审核入口仅对 `agent_reviewer` 角色开放，审核理由必填；通过执行 `AdminApprove`，驳回执行 `AdminReject` 并进入 `delisted` 终态，两者都在状态事务中记录审核员与理由。Feature 15 启用后只把通过事件的证据源替换为沙箱判定 ID，不让本 feature 反向依赖其内部表。
- 提供者的暂停/下架操作同样走“发起迁移请求 → 状态机校验合法性 → 落库 → 审计”的统一路径，不区分“谁发起”对状态机内部逻辑的影响，只影响审计记录里的 `actor_type`。
- `[v4 新增]` 提供者恢复接口同样走这条统一路径，但 `TransitionAgentStatus` 在处理 `ManualResume` 事件时会额外校验 `pause_reason`：`pause_reason = manual` 才允许迁移到 `active`；`pause_reason = health_check` 时返回 `RESUME_REQUIRES_HEALTH_RECOVERY` 错误码，而不是把这条校验散落到 API 层——校验逻辑集中在状态机内部，任何未来新增的恢复入口（例如运营后台的强制恢复）都会自动受到同一条规则约束。

## 接口契约

- 内部接口（Go 分发引擎）：`TransitionAgentStatus(agentId, event, actor) (newStatus, error)`，非法迁移返回 `INVALID_STATE_TRANSITION` 错误码。
- `POST /api/admin/agents/:id/approve` / `reject`：MVP 运营审核通过或驳回，请求体含 `reviewReason`。
- `POST /api/agents/:id/pause` / `POST /api/agents/:id/delist`：提供者操作。
- `POST /api/agents/:id/resume` `[v4 新增]`：提供者恢复操作，仅 `pause_reason = manual` 时成功；`pause_reason = health_check` 时返回 `RESUME_REQUIRES_HEALTH_RECOVERY`（提示"等待自动恢复或联系运营"）。

### 模块 4: 受控上线期风险上限 `[v5 新增，替换此前的"试运行风险上限"提法]`

**涉及层及关键设计:**

- 本模块描述的是业务规则本身（受控上线期是什么、怎么判定、上限怎么算），**不在本 feature 单独实现一个 `IsInProbation()` 服务**——它的代码实现并入 [[7.task-visibility-and-mode]] 的 `ValidateHardConstraints()`（那里已经是五项硬约束的统一校验入口，两个函数都在 Go 分发引擎同进程执行，拆成两个跨服务调用没有必要）。这里只是规则的权威文档位置，不是代码的物理位置。
- `IsInProbation(agentId) bool`：只读查询逻辑，比较 [[12.scoring-system]] 的 `agent_score_snapshots.sample_size`（该 Agent 当前评分样本量）与 `scoring_rule_versions.bayesian_prior.prior_weight`（当前生效规则版本的先验权重）——`sample_size < prior_weight` 即判定为受控上线期。若该 Agent 尚无任何 `agent_score_snapshots` 记录（刚转正、一单未完成），视为 `sample_size = 0`，天然满足受控上线期条件，不需要为"从未有过快照"这种边界单独写分支。
- 这是运行时判定，不在 `agents` 表存储一个需要手动维护的"是否受控中"布尔字段——避免引入一份需要和评分快照保持同步的冗余状态（同步遗漏本身就是一类常见 bug 来源）。
- 受控上线期内的预算上限 = 平台历史任务预算分布的第 30 百分位数（可配置分位数，存于 `agent_status_config.probation_budget_cap_percentile`），由 [[7.task-visibility-and-mode]] 的 `ValidateHardConstraints()` 在做资格过滤时调用 `IsInProbation()` 并应用这个上限，与预算/健康状态/准入状态/截止时间等其它硬约束走同一条判断路径，不额外开分支（[[7.task-visibility-and-mode]] 需要相应更新，见该 feature 的 design.md）。
- 候选列表展示的"新入驻"标识直接复用 `IsInProbation()` 的结果，不重新定义一套判断逻辑。
- `[v5 修改]` 候选列表查询（供 feature 8 使用）只返回 `status = active` 的 Agent；受控上线期的预算上限判断不在这一层做过滤（不满足预算上限的受控期 Agent 直接被 [[7.task-visibility-and-mode]] 的 `ValidateHardConstraints()` 排除，属于资格过滤的一部分，不是 Agent 状态查询的一部分——两者关注点不同，不混在同一个查询里）。

## 数据模型

- `agents.status`（枚举，权威字段，位于 [[2.agent-registration]] 定义的 `agents` 表）
- `agents.pause_reason` `[v4 新增]`（枚举 `health_check` / `manual` / 空，仅 `status = paused` 时有意义，同表同物理位置）
- `agent_health_checks(id PK, agent_id FK, result_code, counted_toward_failure BOOL, checked_at)`（`[v3]` 新增 `counted_toward_failure`：即使 `AGENT_INTERNAL_ERROR` 不计入连续失败计数，仍要落库以便运营排查趋势，只是不参与熔断判断，这个字段让"记录了什么"和"算不算失败"这两件事在数据层面就分开，不用每次查询都重新推导）
- `agent_status_config(agent_id FK 可为空表示全局默认, consecutive_failure_threshold, resume_success_threshold, health_check_interval_seconds, probation_budget_cap_percentile)`（`[v4]` 新增 `resume_success_threshold`、`health_check_interval_seconds` 两列；`[v5]` 将 `trial_risk_cap_amount`（固定金额）替换为 `probation_budget_cap_percentile`（分位数，默认 30）——固定金额不会随平台任务预算规模变化而自适应，分位数更合理，命名也从"试运行"改为"受控上线期"以消除歧义）
- 状态迁移统一写入 [[2.agent-registration]] 定义的共享 `audit_logs` 表。

## 安全考虑

- 审核 API 需要运营角色的权限校验（依赖平台统一鉴权，具体鉴权机制在 [[13.ops-backend-and-metrics]] 中统一设计，本 feature 只声明需要该权限点）。
- 自动暂停事件的触发者记录为系统账户，与人工操作在审计日志中可区分，避免运营误以为是人工操作。
- `[v4]` 提供者无法通过任何接口把一个 `pause_reason = health_check` 的 Agent 强行恢复为 `active`——这条校验在状态机内部而非 API 层实现（见模块 3），保证即使未来新增别的恢复入口也不会绕过。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`（Trusted Intelligence 视觉系统）：Inter 字体、8px 间距系统、12px 卡片圆角。状态语义色：`可接单` 用 success（绿）、`待审核`（沙箱测试中，不进入候选列表，无需候选列表标识）、`暂停` 用 warning、`下架` 用中性色（`on-surface-variant`）、健康检查失败用 error（红）。`[v5]` 受控上线期的"新入驻"标识用 warning（琥珀）+ 标识图标，语义是"数据尚不充分"而非"有问题"，与暂停状态视觉上要能区分（暂停用同色但配不同图标和文案，避免用户误以为新入驻等同于暂停）。所有状态一律搭配文字和图标，不单独用颜色区分。`[v4]` 提供者控制台里，`pause_reason = manual` 的 Agent 展示"恢复接单"按钮；`pause_reason = health_check` 的 Agent 不展示该按钮，改为展示"平台正在自动探测恢复中"的说明文字，避免提供者以为按钮不存在是 bug 而不是设计如此。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 状态机权威位置 | Go 分发引擎（选中）vs 业务服务 | 派发链路在同一进程读取状态可避免跨服务实时查询的延迟和一致性问题，符合“状态转换由后端单一权威模块维护”的项目不变量 |
| 阈值与风险上限来源 | 可配置表（选中）vs 代码常量 | PRD 明确标注这两个数值待产品确认，写入配置表可在不改代码的情况下按产品决策调整 |
| `[v3]` 连续失败计入范围 | 排除 `AGENT_INTERNAL_ERROR`（选中）vs 四类错误一视同仁 | 认证失败/协议不兼容/连接超时反映"平台联系不上或 Agent 不遵守协议"，是客观的连通性问题；`Agent 内部错误`反映的是业务逻辑质量问题，应由评分和试运行机制治理，混入同一熔断计数会让阈值失去明确含义，也可能因为 Agent 处理某类任务时偶发报错而被错误地整体停摆 |
| `[v4]` 恢复阈值与失败阈值是否对称 | 不对称，恢复阈值（2）高于失败阈值（3）不是直接相等，且恢复本身走独立计数器（选中）vs 恢复用与失败相同的单次成功即触发 | 单次成功即恢复会在 Agent 处于故障边缘时造成暂停/恢复快速交替（flapping），候选列表和已生成的匹配结果会跟着抖动；多一次确认的成本很低，换来的稳定性收益更高 |
| `[v4]` 提供者能否强制恢复健康检查暂停的 Agent | 不能，状态机内部拒绝（选中）vs 允许提供者强制恢复但风险自担 | 健康检查暂停的意义就是"平台联系不上/协议不合规"，允许绕过等于让这道防线形同虚设；提供者真正想恢复的路径是修好 Agent 让健康检查通过，而不是在没修好的情况下继续接单 |
| `[v5]` 受控上线期的解除条件 | 对齐评分样本量阈值（选中）vs 固定时长（如"转正后 7 天"）vs 固定任务数（如"前 5 单"） | 固定时长/固定任务数都是任意数字，且与"这个 Agent 到底有没有被验证过"无关（可能 7 天内一单没接，也可能 5 单全部超预期完成却仍被卡住）；对齐评分样本量直接绑定"是否已积累足够真实反馈"这个真正关心的问题，且复用 [[12.scoring-system]] 已有的贝叶斯先验参数，不需要另外定义一套解除规则 |
| `[v5]` 是否额外设总任务数上限 | 不设（选中）vs 单独设一个"受控期最多 N 单"上限 | 受控期本身就被"需要攒够 `prior_weight` 个评分样本"这个条件限制了时长和任务数量上界，额外加一个独立的任务数上限是重复约束同一件事，徒增一个需要维护和解释的配置项 |
