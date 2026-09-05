# 五维评分系统 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 补充说明：`agent_score_snapshots`/`scoring_rule_versions` 被 [[7.task-visibility-and-mode]] 的 `ValidateHardConstraints()` 只读查询，用于判定受控上线期（[[3.agent-health-lifecycle]] F-006），不需要本 feature 反过来做任何改动 |
| 2026-08-23 | v3   | 落地系统响应时间、快照输入证据、最旧优先批处理和 EventBridge 定时调用 |
| 2026-08-31 | v4   | 将五维快照、样本置信度和同分类履约统计接入正式工作流候选证据 |
| 2026-09-02 | v5   | 增加逐工作流节点反馈事实、终态反馈界面与脱敏派生数据边界 |
| 2026-09-04 | v6   | 明确 `priorWeight` 只用于评分平滑和置信度，不再承担 Agent 冷启动资金门禁 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（评分提交 API 与快照计算）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 评分数据分离

**涉及层及关键设计:**

- `task_ratings` 只存发布者主观评分（质量反馈、沟通体验），系统计算的争议率、历史完成规模、响应速度不经过这张表，而是由后台任务直接从 `task_results`、[[13.dispute-and-arbitration]] 的仲裁记录、`task_assignments` 的响应时间戳计算得出，从数据模型层面杜绝「系统计算项被提供者接口误改」的可能，而不是靠权限校验兜底。
- 早期 migration 已创建但评分公式从未读取的 `timeliness`、`requirement_fit`、`compliance`
  列由 `0020_subjective_rating_boundary` 保留为可空历史字段；新接口严格拒绝这些字段，也
  不再写入。这样纠正输入边界而不删除已有记录。
- 旧单 Agent 任务继续使用 `task_ratings`；正式多 Agent 任务使用 `workflow_node_feedback`。
  评分快照在仓储边界通过 `UNION ALL` 读取两种历史事实，避免页面或调用方理解兼容分支。
- `workflow_node_feedback` 同时固化 `task_id`、`workflow_node_id`、`assignment_id` 和
  `agent_id`。这些归属全部由服务端在事务内从已验收节点解析，浏览器只提交节点 ID 与
  反馈内容，不能把评分伪造到另一个 Agent 名下。

### 模块 2: 小样本校正与时间衰减

**涉及层及关键设计:**

- 质量评分使用贝叶斯平滑：`smoothed_score = (prior_mean * prior_weight + sum(scores)) / (prior_weight + sample_size)`，`prior_mean`、`prior_weight` 存于 `scoring_rule_versions`，与排序权重一样版本化管理，复用 [[8.matching-and-candidates]] 已验证的「规则版本化 + 纯函数计算」模式，不重新发明一套版本管理机制。
- 时间衰减：近期指标（如近 90 天）与全周期指标分别计算并展示，衰减权重函数同样版本化；原始评分记录永不删除，衰减只影响聚合计算，不影响历史可追溯性。

### 模块 3: 争议率口径

**涉及层及关键设计:**

- 争议率计算只统计 [[13.dispute-and-arbitration]] 中 `arbitration_result = agent_at_fault` 的记录；`withdrawn`（撤销）与 `agent_not_at_fault`（无责）的争议不计入分子，但计入分母（历史争议总数用于展示，具体是否计入分母作为可配置项，默认不计入分母以避免对被误判后撤销的 Agent 造成持续影响）。

### 模块 4: 历史完成规模

**涉及层及关键设计:**

- `log(1 + completed_task_count_or_amount)` 作为置信度信号的输入之一，不单独构成排序或展示的「质量分」，不做全站最大值归一化（避免极端值压缩其余 Agent 的区分度）。

### 模块 5: 评分快照计算

**涉及层及关键设计:**

- 定时任务按 Agent 重新计算并写入 `agent_score_snapshots`（各维度当前值、样本量、规则版本、计算时间），前端展示直接读快照，不在请求路径上现算，避免评分展示接口的响应时间随历史数据增长而变差。
- 每个快照的 `input_evidence` 固化 rating、rated task、accepted/responded assignment、
  completed task、arbitration decision ID；公开接口只返回证据数量，原始 ID 仅供授权审计。
- 生产调度由 CDK 中的 EventBridge API Destination 每小时调用内部 worker，每批优先选择
  从未计算或最久未更新的 100 个 Agent，避免固定 `ORDER BY id LIMIT N` 造成尾部饥饿。
  Bearer token 通过 Secrets Manager 动态引用注入 Lambda 与 Connection，不进入 synth 模板。

### 模块 6: 候选选择证据 `[v4 新增]`

**涉及层及关键设计:**

- 分发引擎在生成 `JobDistributionRecord` 时读取最新 `agent_score_snapshots`，把 `score`、`sample_size`、`dimensions` 和 `dispute_rate` 固化进候选快照；浏览器切换比较偏好时不重新查询或现算评分。
- 置信度由样本量相对规则版本中的贝叶斯 `priorWeight` 计算，映射为高、中、低三档。它表达证据充分程度，不参与伪装成精确概率，也不改变原始综合评分。
- 相似任务统计从同分类、已验收的正式 workflow assignment 计算完成量、按时率和返工率；未分配候选、沙箱调用和未验收结果都不能进入统计。候选卡展示全周期五维值，Agent 详情仍保留近期/全周期并列视图。

### 模块 7: 逐阶段反馈与后续数据复用 `[v5 新增]`

**涉及层及关键设计:**

- 已结算、已退款或争议中的正式任务只允许评价状态为 `accepted` 且存在已接单
  assignment 的节点；每个 `workflow_node_id + publisher_id` 唯一，幂等记录、反馈事实、
  `status_version` 与任务事件在同一事务提交。
- 页面在“结算或争议”阶段按工作流节点展示 Agent、交付质量、沟通体验、优点标签、
  文字反馈和改进建议。每阶段独立回执，避免一条总评分掩盖 PRD、设计和 Coding 的差异。
- 结构化评分与标签可用于履约统计和后续检索特征。原始文字是受控业务事实，不直接写入
  向量库或训练集；未来派生任务必须先脱敏、保留来源与 schema 版本，并在模型训练场景
  过滤 `allow_model_training=false` 的记录。任务正文、附件、钱包与凭据永不进入派生样本。

## 接口契约

- `POST /api/tasks/:id/rating`：发布者提交质量反馈与沟通体验评分（仅验收后可提交一次）。
- `GET /api/tasks/:id/workflow-feedback`：发布者读取自己正式任务的逐阶段反馈。
- `POST /api/tasks/:id/workflow-nodes/:nodeId/feedback`：发布者评价一个已验收节点；请求必须携带幂等键，Agent 与 assignment 由服务端解析。
- `GET /api/agents/:id/score`：返回五维评分（含近期/全周期、样本量、规则版本）、系统
  响应时间和公开证据数量。
- 内部：`ComputeAgentScoreSnapshot(agentId, ruleVersion) snapshot`（纯函数，给定相同输入和规则版本可复现）。

## 数据模型

- `task_ratings(id PK, task_id FK, agent_id FK, quality_score, communication_score, submitted_at)`
- `workflow_node_feedback(id PK, task_id FK, workflow_node_id FK, assignment_id FK, agent_id FK, publisher_id, quality, communication, feedback_text, strengths, improvement_text, allow_model_training, schema_version, created_at)`
- `agent_score_snapshots(id PK, agent_id FK, score, sample_size, dispute_rate, completed_scale, dimensions JSONB, input_evidence JSONB, rule_version, computed_at)`
- `scoring_rule_versions(id PK, version, weights JSONB, bayesian_prior JSONB, decay_function JSONB, created_at, deprecated_at)`

## 安全考虑

- 评分提交接口校验请求者是该任务的发布者且任务已验收，防止重复评分或越权评分。
- 系统计算维度（争议率、历史完成规模、响应速度）不对外暴露任何写接口。
- 原始逐阶段反馈只允许任务发布者读取；公开任务详情和 Agent Webhook 不包含反馈正文。
- 模型训练许可是独立布尔值，并要求存在有效文字反馈；许可不扩展到任务正文、附件、钱包或密钥。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：评分展示主分值用 `title` 字号，样本量等辅助信息用次要文字色（`on-surface-variant`）、更小字号，避免样本量过小时视觉上与充分样本的评分同等权威。近期指标与全周期指标并排展示，不用同一数字掩盖差异。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 系统计算项的防篡改方式 | 数据模型隔离，不提供写接口（选中）vs 提供写接口 + 权限校验 | 不存在写接口意味着这一类误用在接口层面就不可表达，比权限校验更彻底（AGENTS.md §5.1.4「错误用法应困难」） |
| 评分计算时机 | 定时快照（选中）vs 请求时实时计算 | 实时计算会随着历史评价数量增长拖慢展示接口；快照方式将计算成本从读路径移到后台，符合「把复杂度向下吸收」 |
