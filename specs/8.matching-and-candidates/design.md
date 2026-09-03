# V0 匹配与候选列表 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 前端视觉规范中的"试运行标识"改为"新入驻标识" |
| 2026-08-31 | v3   | 候选生成前移到托管前；增加三种偏好、履约统计、置信度和双来源案例 |
| 2026-08-31 | v4   | 增加独立预算偏好、能力修正命令及已覆盖/未覆盖排序证据 |
| 2026-08-31 | v5   | React Flow 候选关系图转正，选定后收敛并支持按阶段展开改选 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，匹配管道权威实现）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 匹配管道

**涉及层及关键设计:**

- 四阶段纯函数管道：`FilterByCategory → FilterByEligibility(ValidateHardConstraints) → MatchByTags → RankByRules`，每阶段输入输出明确，互不感知对方内部实现，符合「不同层应有不同抽象」（AGENTS.md §3.7 / 工程方法论 §3.7）。
- `planning/selecting` 与托管后的 `running/matching` 共用同一候选快照和输入指纹；前者只生成候选供选择，后者只有在没有已冻结选择的兼容路径才重新计算。`budget_preference_minor` 按节点权重拆为 `price_preference_minor` 并只进入排序，不由硬约束过滤报价，也不复用任何资金字段。
- 任务提交时 Business API 从自然语言按词表识别规范能力；节点选择前，发布者可通过独立命令修正 `node.tags`。修改更新时间会进入匹配输入指纹，随后显式 rematch 生成新快照；能力保存和匹配失败可分别重试。
- 管道放在 Go 分发引擎：匹配需要读取 Agent 实时状态（[[3.agent-health-lifecycle]] 权威数据所在服务），放在同一进程避免跨服务查询的实时性问题，与派发（[[9.dispatch-and-acceptance]]）共享同一批 Agent 状态读取路径。

### 模块 2: 排序规则版本化

**涉及层及关键设计:**

- 排序权重（匹配度、质量、价格、响应速度、负载、历史完成量）存储在 `ranking_rule_versions` 表，每次规则调整生成新版本号，历史 `JobDistributionRecord` 引用当时生效的版本号，不随配置更新静默改变（PRD 验收标准直接要求）。
- 排序函数 `RankByRules(candidates, ruleVersion)` 为纯函数：给定相同候选集合、相同规则版本，必须产生相同顺序，不依赖任何隐式全局状态或时间戳，以保证可复现性。

### 模块 3: JobDistributionRecord

**涉及层及关键设计:**

- 每次匹配执行后，无论是否产生候选，都写入一条 `job_distribution_records`，无候选场景的 `filter_reasons` 记录主要限制条件，供前端和运营排查使用。
- 记录内容包含任务快照、候选集、每个候选的特征值、排序结果、规则版本和最终选择。托管前选择事务从这份快照读取 `quoteMinor` 并回填 `final_selection_agent_id`；正式 assignment 在托管确认后另行创建，两者不得共用同一状态含义。

### 模块 4: 候选列表前端

**涉及层及关键设计:**

- React Flow 关系图与详细候选卡片读取同一份 `FormalWorkflowNode` 投影，不建立浏览器内第二套选择状态。未选择节点展示候选，已选择节点只保留最终 Agent；只有进入该节点重新选择模式时才展开原冻结候选。图中阶段依赖在两端均已冻结 Agent 后使用高亮流动虚线，表达已确认的执行链路，而不是允许用户改线的编排器。
- 候选卡片展示字段与 `JobDistributionRecord.candidates` 的冻结证据一一对应，不额外发起字段级请求。综合推荐按 `rankScore`，质量优先按评分，性价比优先按单位报价质量切换本地视图；用户无论从哪个视图选择，服务端都只接受当前候选快照中的 Agent ID。
- 五维分条读取 `agent_score_snapshots.dimensions`，样本量结合贝叶斯先验给出高/中/低置信度。相似任务完成量、按时率和返工率只统计同分类且已验收的正式 assignment；责任争议率读取权威评分快照。
- 案例查询优先聚合同分类公开任务中已验收的工作流结果，再补充 `agent_portfolio_cases`，最终在 SQL 子查询内部限制为 3 条。来源随快照固化，浏览器只对 HTTP(S) `previewRef` 生成外链。

## 接口契约

- 内部：`RunWorkflowNodeMatching(taskId, workflowNodeId) JobDistributionRecord`（输入指纹包含节点与任务快照；执行门禁不进入指纹，避免托管确认凭空生成另一版候选）。
- `GET /api/tasks/:id/candidates`：返回最新一次 `JobDistributionRecord` 的候选集合与匹配理由。
- `GET /api/tasks/:id/workflow-nodes/:nodeId/candidates`：返回节点最新候选快照和选择证据。
- `POST /api/tasks/:id/workflow-nodes/:nodeId/rematch`：仅节点处于 `selecting` 时重新生成候选；不得修改其他节点的冻结选择。
- `PATCH /api/tasks/:id/workflow`：保存可空的整单预算偏好并按节点权重分配；任一节点已选后锁定。
- `PATCH /api/tasks/:id/workflow-nodes/:nodeId/preferences`：修正该节点能力标签；只允许发布者在 `planning/selecting` 且未选 Agent 时调用，成功后由页面请求节点 rematch。

## 数据模型

- `job_distribution_records(id PK, task_id FK, task_snapshot JSONB, candidate_set JSONB, filter_reasons JSONB, feature_values JSONB, ranking_result JSONB, rule_version, final_selection_agent_id, created_at)`
- `ranking_rule_versions(id PK, version, weights JSONB, created_at, deprecated_at)`
- `task_workflow_runs.budget_preference_minor` 与 `task_workflow_nodes.price_preference_minor` 只表达排序偏好；`budget_cap_minor/agreed_amount_minor/quoted_total_minor` 只表达冻结成交事实，禁止相互回退。

## 安全考虑

- `task_snapshot` 中不包含任务的私密敏感字段之外的信息泄漏风险；候选集合展示的 Agent 信息遵循 [[7.task-visibility-and-mode]] 的脱敏原则，不展示 Agent 未公开的内部字段（如凭证配置状态之外的细节）。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：候选匹配相关的强调色使用 violet（`primary`，规范中专门保留给「AI、Agent 匹配、推荐」语义），cyan（`secondary`）只稀疏用于实时协议状态，不与托管/成功状态的 teal、green 混用。候选卡片中的报价、评分、历史完成量等数值右对齐排列以便扫描比较；`[v2]` 新入驻标识（受控上线期）复用 [[3.agent-health-lifecycle]] 定义的样式，不重新设计一套。列表模式需满足移动端和无障碍访问（PRD §8.2 要求）。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 匹配管道位置 | Go 分发引擎（选中）vs 业务服务 | 匹配需要读取 Agent 实时状态，与状态机权威数据同进程可避免额外的服务间往返和一致性问题 |
| 标签检索存储 | PostgreSQL（选中）vs 引入 pgvector/Qdrant | PRD 明确要求初期不为标签检索单独引入新数据库；V0 是精确匹配和规则排序，不需要向量检索能力 |
