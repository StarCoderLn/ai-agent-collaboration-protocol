# 任务创建与发布预览 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 新增附件按分类大小/类型上限配置（模块 3、数据模型） |
| 2026-08-20 | v3   | 新增模块 5「手续费计算」，费率 0.4% 确定，gas 成本兜底替代最低任务预算 |
| 2026-08-20 | v4   | 最短执行周期落到 `task_timing_config` 配置表（默认 30 分钟），明确其作用范围仅限流水线开销 |
| 2026-08-28 | v5   | USDC 任务预算设置 1 USDC 下限；预览接口返回费率与最低服务费，页面明确费用承担方 |
| 2026-08-30 | v6   | 快速发布页增加独立标题，按实际主表单、折叠设置和右侧预览同步交互设计 |
| 2026-08-31 | v7   | 补充说明改为可选并复用标题兜底；标签改为直接输入，不再请求并展示推荐标签墙 |
| 2026-08-31 | v8   | 状态机改为发布后规划选人、冻结准确总价后待托管；发布事务同步创建正式工作流 |
| 2026-08-31 | v9   | 发布端移除预算与技能标签；服务端识别能力，预算偏好延后到匹配阶段 |
| 2026-08-31 | v10  | 待托管改选在原状态内修订固定价，不新增临时生命周期状态 |
| 2026-08-31 | v10  | 增加任务软归档命令，统一市场、工作台、详情与统计的隐藏语义 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（Next.js + AWS Lambda，任务 CRUD 与状态机权威实现）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 任务主状态机（权威定义）

**涉及层及关键设计:**

- 严格定义显式状态与合法迁移：`draft → planning → awaiting_escrow → matching → awaiting_agent_acceptance → executing → awaiting_review → pending_settlement → settled`，以及取消/退款、接单失败、超时、返工和争议等异常分支。`planning` 吸收工作流拆分、候选生成和报价冻结，避免在金额未知时提前托管。
- 使用可辨识联合 + 迁移表实现，任何模块发起迁移都必须通过统一的 `TransitionTaskStatus(taskId, event, actor)` 函数，任务状态字段本身不允许被直接 UPDATE，避免状态知识散落到多个调用方（AGENTS.md §5.1.2）。
- 本 feature 的发布路径实现 `draft → planning`，正式工作流全部节点冻结报价后通过同一状态机执行 `planning → awaiting_escrow`；后续状态由 [[6.escrow-sync-and-wallet]]、[[8.matching-and-candidates]]、[[9.dispatch-and-acceptance]] 在同一权威模块中推进，而不是各自新建状态机。

### 模块 2: 分类与标签服务

**涉及层及关键设计:**

- 分类树、规范标签、同义词和弃用关系版本化存储；任务创建时快照当前生效版本号，历史任务不因后续分类调整静默改变（PRD FR-M01 验收标准）。
- 发布页只加载受控分类树，不要求用户理解标签协议。提交边界从标题、说明和能力描述中按版本化词表识别规范能力；匹配阶段再展示识别结果，用户可从平台建议中选择或输入自定义能力。服务端始终负责同义词归一、禁用词和数量边界，保证任务与 Agent 共用同一匹配语言。

### 模块 3: 创建任务表单与校验

**涉及层及关键设计:**

- 快速发布主表单呈现任务标题、可选补充说明、服务分类和截止日期；可见范围放入折叠高级设置，不展示技能标签、预算或内部任务合同。补充说明为空时用标题填充服务端非空的 `description` 字段，后续 PRD Agent 再承担需求澄清与拆分。
- 桌面端右侧使用固定宽度的粘性需求预览与发布操作区，移动端按文档流排列。预览只概括用户已填写的数据与发布后的步骤，不在尚未产生候选时伪造费用数字。
- 提交校验使用字段 ID 映射到具体控件；失败时滚动、聚焦并关联 `aria-describedby` 到首个错误。错误摘要和字段错误不得同时重复播报同一问题。
- 服务端校验独立于前端实现（不信任前端），复用同一套校验规则定义（单一权威位置：一份 JSON Schema 风格的规则定义，前后端各自加载校验，而非各写一份规则）。
- `[v2 新增]` 附件校验读取 `attachment_category_limits` 配置表（按 `category_id` 查找对应的 `max_size_mb`、`allowed_mime_types`，未命中时退回平台默认值），调整某个分类的上限只是一条配置更新，不需要改代码或重新部署——这也是选择"配置表"而不是"代码常量"的核心原因（呼应 requirements.md 里"产品可随时调整"的要求）。
- `[v4 新增]` 截止时间校验读取 `task_timing_config.min_execution_period_seconds`（默认 1800 秒/30 分钟），**全局单一值，不按任务分类拆分**：这条下限的作用是保证平台调度流水线（[[8.matching-and-candidates]] 匹配 + [[9.dispatch-and-acceptance]] 接单等待）跑得完，跟任务类别无关，所有分类共用同一条流水线、同样的开销；"某个 Agent 能不能真的在截止时间前做完"这个才跟分类/具体任务相关，已经由 [[8.matching-and-candidates]] 的"预计时长 vs 截止时间"硬约束逐个 Agent 判断，不在这里重复。

### 模块 4: 发布预览

**涉及层及关键设计:**

- 发布预览不展示预算费用；正式托管卡片只读取 workflow run 的 `quoted_total_minor`。可选预算上限存于独立 preference 字段，任何资金接口都不得将其回退为托管金额。

### 模块 6: 发布事务与正式工作流 `[v8 新增]`

**涉及层及关键设计:**

- `POST /api/tasks/:id/submit` 在任务、事件、审计和幂等结果的同一外层事务中调用 `ensureFormalWorkflow()`，创建 workflow run、节点和 DAG 边。创建失败则发布整体回滚，不留下已发布但无法选人的任务。
- workflow run 初始为 `planning`，所有节点初始为 `selecting`。节点候选允许并行生成，但选择只记录 `selected_agent_id`、候选快照 ID 和冻结报价；它不创建 assignment，也不占用 Agent。
- 最后一个节点选择成功的事务负责汇总所有 `agreed_amount_minor`，写入 `quoted_total_minor` 和确认时间，并将任务原子迁移到 `awaiting_escrow`。浏览器只提交 Agent ID，不能提交或覆盖成交金额。
- 待托管但尚无 escrow intent 时，改选事务保持 `awaiting_escrow` 不变，增加任务版本并重算 `quoted_total_minor` 与任务固定价；不把任务退回 `planning`，避免为一次局部修订扩散新的页面和状态机分支。

### 模块 5: 手续费计算 `[v3 新增]`

**涉及层及关键设计:**

- 唯一权威函数 `CalculatePlatformFee(amount, currency) feeAmount`：`feeAmount = max(amount × fee_rate_bps / 10000, gas_cost_floor_estimate)`。费率（`fee_rate_bps = 40`，即 0.4%）与 `gas_cost_floor_estimate` 均存于 `platform_fee_config` 表，非硬编码。
- 这个函数是预览（本模块）和实际验收结算（[[11.execution-tracking-and-delivery]]）唯一共用的计算入口，两处都调用同一份代码，不允许各自实现一遍——这是 requirements.md AC-007 要求"预览与实际结算一致"的实现方式，不是靠约定，是靠只有一处代码能算这个数字。
- `gas_cost_floor_estimate` 是静态可配置的估算值（MVP 不接入实时 gas 价格预言机，避免为了一个兜底下限引入额外的外部依赖和价格波动带来的用户体验问题），由运营定期按网络实际 gas 价格调整配置值。
- Agent 成交报价和匹配阶段预算偏好的有效范围为 1–100,000 USDC；最低平台服务费当前为 0.05 USDC。低价成交可能触发最低服务费，因此准确报价确认页必须同时展示名义费率、最低服务费和实际预计金额，不能只宣传 0.4%。

### 模块 7: 规划前任务软归档 `[v10 新增]`

- `DELETE /api/tasks/:id` 是幂等领域命令，不执行物理删除。服务端在同一事务中校验发布者、限制状态为 `draft/planning`、写入 `archived_at`、递增版本并记录事件与审计。
- `findOwned`、公开详情、市场列表、发布者列表及两类统计全部由 PostgreSQL 仓储统一过滤 `archived_at IS NULL`；调用方不各自维护“是否显示”的重复判断。
- `awaiting_escrow` 及其后状态返回 `TASK_ARCHIVE_NOT_ALLOWED`。这些状态可能已有托管、分配、交付或争议证据，只能由对应资金状态机处理，不能通过归档隐藏后当作取消。

## 接口契约

- `POST /api/tasks`（创建草稿）、`PATCH /api/tasks/:id`（编辑草稿）、`DELETE /api/tasks/:id`（仅规划前软归档）、`POST /api/tasks/:id/submit`（提交，原子创建正式工作流并触发 `draft → planning`）。
- `GET /api/tasks/:id/preview`：旧草稿兼容预览；新发布链路不依赖该接口生成预算或托管金额。
- `GET /api/categories`：发布页与 Agent 上架页共用的受控分类树。`GET /api/tags/suggest?q=` 由匹配阶段能力编辑器按需使用；发布提交时的自动识别与所有能力修改仍在服务端边界规范化和校验。

## 数据模型

- `tasks(id PK, publisher_id, title, category_id, category_version, description, acceptance_criteria, deliverable_format, pricing_type, budget_min, budget_max, currency, deadline, required_capability, tags TEXT[], attachments JSONB, visibility, assignment_mode, status, archived_at, created_at, updated_at)`；`archived_at` 非空仅表示产品列表隐藏，不删除任何关联证据。
- `categories(id PK, name, parent_id, version, deprecated_at)`
- `tags(id PK, name, canonical_tag_id, version, deprecated_at)`（`canonical_tag_id` 为空表示自身即规范标签）
- `attachment_category_limits(category_id FK PK, max_size_mb, allowed_mime_types TEXT[])` `[v2 新增]`：无匹配行时使用平台默认值（代码常量兜底，仅用于"配置表里彻底没有这一条"的极端情况，不作为常规调整入口）。
- `platform_fee_config(id PK, fee_rate_bps, gas_cost_floor_estimate, currency, effective_from)` `[v3 新增]`：版本化（`effective_from`），历史任务结算引用当时生效的费率，费率调整不静默改变历史记录的费用口径——与 [[8.matching-and-candidates]] 排序规则版本化的处理方式一致。
- `task_timing_config(id PK, min_execution_period_seconds, effective_from)` `[v4 新增]`：全局单一配置（不按分类），同样版本化，理由同上。

## 安全考虑

- `[v2 修改]` 附件上传按分类做类型白名单与大小上限的硬校验（读取 `attachment_category_limits`），一律拒绝可执行文件类型（不因分类配置而放开这一条，属于跨分类的通用红线，不下放到配置表）。
- 描述、验收标准等自由文本字段做基础 XSS 防护（输出时转义），因其会在候选 Agent 与运营后台展示。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`（Amethyst Intelligence 视觉系统）：Inter 字体、8px 间距系统、12px 卡片圆角、8px 表单控件圆角。主表单与右侧预览使用同一内容轨道和一致的深色分层卡片；金额、截止日期等需要精确核对的字段使用易扫描的数字样式。托管前提示使用 warning（琥珀）而非 error（红），因为用户此时仍可修改，尚非不可逆的错误态。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 状态机实现位置 | 与任务 CRUD 同服务（选中）vs 独立状态机微服务 | MVP 阶段任务状态机变更频率不高，独立微服务会引入额外的服务间调用和部署复杂度，收益不明确；未来若状态机复杂度显著上升可再拆分 |
| 校验规则复用方式 | 共享 Schema 定义（选中）vs 前后端独立实现 | 避免同一条业务规则（如预算区间大小关系）在前后端各自实现后出现不同步 |
| `[v2]` 附件上限粒度 | 按分类配置表（选中）vs 全平台统一常量 | 不同分类的典型交付物大小差异一个数量级以上（文档 vs 视频），统一常量要么卡死大文件分类要么对小文件分类形同虚设；配置表还能让产品在不改代码的情况下按运营需要随时调整 |
| `[v5]` 金额与费用下限 | 1 USDC 业务下限 + 0.05 USDC 结算成本兜底（选中）vs 接受任意正数 | 1 USDC 下限让任务与 Agent 报价规则一致，避免最低服务费吃掉全部成交收入；实际费率可能高于 0.4% 时通过服务端明细透明展示，不用隐藏规则或前端估算 |
