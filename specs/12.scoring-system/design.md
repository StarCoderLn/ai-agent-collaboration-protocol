# 五维评分系统 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 补充说明：`agent_score_snapshots`/`scoring_rule_versions` 被 [[7.task-visibility-and-mode]] 的 `ValidateHardConstraints()` 只读查询，用于判定受控上线期（[[3.agent-health-lifecycle]] F-006），不需要本 feature 反过来做任何改动 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（评分提交 API 与快照计算）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 评分数据分离

**涉及层及关键设计:**

- `task_ratings` 只存发布者主观评分（质量反馈、沟通体验），系统计算的争议率、历史完成规模、响应速度不经过这张表，而是由后台任务直接从 `task_results`、[[13.dispute-and-arbitration]] 的仲裁记录、`task_assignments` 的响应时间戳计算得出，从数据模型层面杜绝「系统计算项被提供者接口误改」的可能，而不是靠权限校验兜底。

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

## 接口契约

- `POST /api/tasks/:id/rating`：发布者提交质量反馈与沟通体验评分（仅验收后可提交一次）。
- `GET /api/agents/:id/score`：返回五维评分（含近期/全周期、样本量、规则版本）。
- 内部：`ComputeAgentScoreSnapshot(agentId, ruleVersion) snapshot`（纯函数，给定相同输入和规则版本可复现）。

## 数据模型

- `task_ratings(id PK, task_id FK, agent_id FK, quality_score, communication_score, submitted_at)`
- `agent_score_snapshots(id PK, agent_id FK, dimension, recent_value, lifetime_value, sample_size, rule_version, computed_at)`
- `scoring_rule_versions(id PK, version, weights JSONB, bayesian_prior JSONB, decay_function JSONB, created_at, deprecated_at)`

## 安全考虑

- 评分提交接口校验请求者是该任务的发布者且任务已验收，防止重复评分或越权评分。
- 系统计算维度（争议率、历史完成规模、响应速度）不对外暴露任何写接口。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：评分展示主分值用 `title` 字号，样本量等辅助信息用次要文字色（`on-surface-variant`）、更小字号，避免样本量过小时视觉上与充分样本的评分同等权威。近期指标与全周期指标并排展示，不用同一数字掩盖差异。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 系统计算项的防篡改方式 | 数据模型隔离，不提供写接口（选中）vs 提供写接口 + 权限校验 | 不存在写接口意味着这一类误用在接口层面就不可表达，比权限校验更彻底（AGENTS.md §5.1.4「错误用法应困难」） |
| 评分计算时机 | 定时快照（选中）vs 请求时实时计算 | 实时计算会随着历史评价数量增长拖慢展示接口；快照方式将计算成本从读路径移到后台，符合「把复杂度向下吸收」 |
