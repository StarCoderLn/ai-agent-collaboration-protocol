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

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（Next.js + AWS Lambda，任务 CRUD 与状态机权威实现）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 任务主状态机（权威定义）

**涉及层及关键设计:**

- 严格按 PRD §6.1 定义显式状态与合法迁移：`草稿 → 待托管 → 待匹配 → 待接单 → 执行中 → 待验收 → 已完成`，以及异常分支（取消/退款、接单失败回待匹配、超时、返工、争议）。
- 使用可辨识联合 + 迁移表实现，任何模块发起迁移都必须通过统一的 `TransitionTaskStatus(taskId, event, actor)` 函数，任务状态字段本身不允许被直接 UPDATE，避免状态知识散落到多个调用方（AGENTS.md §5.1.2）。
- 本 feature 只实现 `草稿 ⇄ 待托管` 两个状态及其迁移；后续状态由 [[6.escrow-sync-and-wallet]]、[[8.matching-and-candidates]]、[[9.dispatch-and-acceptance]] 等 feature 在同一状态机模块中增量注册迁移规则，而不是各自新建状态机。

### 模块 2: 分类与标签服务

**涉及层及关键设计:**

- 分类树、规范标签、同义词和弃用关系版本化存储；任务创建时快照当前生效版本号，历史任务不因后续分类调整静默改变（PRD FR-M01 验收标准）。
- 页面只加载受控分类树，标签由用户直接输入，不为缺少任务上下文的全量推荐词表增加认知负担。前端仅执行即时的大小写、空格、数量和重复项检查；服务端继续使用版本化词表完成同义词归一、禁用词校验和最终存储，保证候选匹配（feature 8）的标签口径一致。

### 模块 3: 创建任务表单与校验

**涉及层及关键设计:**

- 快速发布主表单呈现任务标题、可选补充说明、服务分类、技能标签、固定预算和截止日期；可见范围放入折叠的高级设置，自动分配与最终人工验收由平台流程说明，不要求用户理解内部任务合同。补充说明为空时，前端用标题填充服务端非空的 `description` 字段，保留用户真实表达且不虚构功能；后续 PRD Agent 再承担需求澄清与拆分。
- 桌面端右侧使用固定宽度的粘性需求预览与发布操作区，移动端按文档流排列。预览只概括用户已填写的数据和服务端费用规则，不在浏览器维护第二份草稿或重新计算资金数字。
- 提交校验使用字段 ID 映射到具体控件；失败时滚动、聚焦并关联 `aria-describedby` 到首个错误。错误摘要和字段错误不得同时重复播报同一问题。
- 服务端校验独立于前端实现（不信任前端），复用同一套校验规则定义（单一权威位置：一份 JSON Schema 风格的规则定义，前后端各自加载校验，而非各写一份规则）。
- `[v2 新增]` 附件校验读取 `attachment_category_limits` 配置表（按 `category_id` 查找对应的 `max_size_mb`、`allowed_mime_types`，未命中时退回平台默认值），调整某个分类的上限只是一条配置更新，不需要改代码或重新部署——这也是选择"配置表"而不是"代码常量"的核心原因（呼应 requirements.md 里"产品可随时调整"的要求）。
- `[v4 新增]` 截止时间校验读取 `task_timing_config.min_execution_period_seconds`（默认 1800 秒/30 分钟），**全局单一值，不按任务分类拆分**：这条下限的作用是保证平台调度流水线（[[8.matching-and-candidates]] 匹配 + [[9.dispatch-and-acceptance]] 接单等待）跑得完，跟任务类别无关，所有分类共用同一条流水线、同样的开销；"某个 Agent 能不能真的在截止时间前做完"这个才跟分类/具体任务相关，已经由 [[8.matching-and-candidates]] 的"预计时长 vs 截止时间"硬约束逐个 Agent 判断，不在这里重复。

### 模块 4: 发布预览

**涉及层及关键设计:**

- 预览页从后端预览接口获取渲染数据（费用计算、不可逆提示文案），不在前端本地重算费用，避免费率变更时前后端口径不一致。

### 模块 5: 手续费计算 `[v3 新增]`

**涉及层及关键设计:**

- 唯一权威函数 `CalculatePlatformFee(amount, currency) feeAmount`：`feeAmount = max(amount × fee_rate_bps / 10000, gas_cost_floor_estimate)`。费率（`fee_rate_bps = 40`，即 0.4%）与 `gas_cost_floor_estimate` 均存于 `platform_fee_config` 表，非硬编码。
- 这个函数是预览（本模块）和实际验收结算（[[11.execution-tracking-and-delivery]]）唯一共用的计算入口，两处都调用同一份代码，不允许各自实现一遍——这是 requirements.md AC-007 要求"预览与实际结算一致"的实现方式，不是靠约定，是靠只有一处代码能算这个数字。
- `gas_cost_floor_estimate` 是静态可配置的估算值（MVP 不接入实时 gas 价格预言机，避免为了一个兜底下限引入额外的外部依赖和价格波动带来的用户体验问题），由运营定期按网络实际 gas 价格调整配置值。
- 任务预算下限为 1 USDC、上限为 100,000 USDC；最低平台服务费当前为 0.05 USDC。低价任务可能触发最低服务费，因此页面必须同时展示名义费率、最低服务费和实际预计金额，不能只宣传 0.4%。

## 接口契约

- `POST /api/tasks`（创建草稿）、`PATCH /api/tasks/:id`（编辑草稿）、`POST /api/tasks/:id/submit`（提交，触发 草稿→待托管 迁移）。
- `GET /api/tasks/:id/preview`：返回任务摘要，以及 `amountMinor`、`platformFeeMinor`、`agentReceivesMinor`、`feeBasisPoints`、`minimumPlatformFeeMinor`、`feeRuleVersion` 和不可逆提示；全部费用字段来自服务端 `CalculatePlatformFee()` 及同一份费率配置。
- `GET /api/categories`：发布页与 Agent 上架页共用的受控分类树。`GET /api/tags/suggest?q=` 继续作为服务端词表能力保留，但快速发布页不再无上下文加载并展示完整推荐墙；规范化和安全校验仍在提交边界执行。

## 数据模型

- `tasks(id PK, publisher_id, title, category_id, category_version, description, acceptance_criteria, deliverable_format, pricing_type, budget_min, budget_max, currency, deadline, required_capability, tags TEXT[], attachments JSONB, visibility, assignment_mode, status, created_at, updated_at)`
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
