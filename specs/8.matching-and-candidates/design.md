# V0 匹配与候选列表 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 前端视觉规范中的"试运行标识"改为"新入驻标识" |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，匹配管道权威实现）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 匹配管道

**涉及层及关键设计:**

- 四阶段纯函数管道：`FilterByCategory → FilterByEligibility(ValidateHardConstraints) → MatchByTags → RankByRules`，每阶段输入输出明确，互不感知对方内部实现，符合「不同层应有不同抽象」（AGENTS.md §3.7 / 工程方法论 §3.7）。
- 管道放在 Go 分发引擎：匹配需要读取 Agent 实时状态（[[3.agent-health-lifecycle]] 权威数据所在服务），放在同一进程避免跨服务查询的实时性问题，与派发（[[9.dispatch-and-acceptance]]）共享同一批 Agent 状态读取路径。

### 模块 2: 排序规则版本化

**涉及层及关键设计:**

- 排序权重（匹配度、质量、价格、响应速度、负载、历史完成量）存储在 `ranking_rule_versions` 表，每次规则调整生成新版本号，历史 `JobDistributionRecord` 引用当时生效的版本号，不随配置更新静默改变（PRD 验收标准直接要求）。
- 排序函数 `RankByRules(candidates, ruleVersion)` 为纯函数：给定相同候选集合、相同规则版本，必须产生相同顺序，不依赖任何隐式全局状态或时间戳，以保证可复现性。

### 模块 3: JobDistributionRecord

**涉及层及关键设计:**

- 每次匹配执行后，无论是否产生候选，都写入一条 `job_distribution_records`，无候选场景的 `filter_reasons` 记录主要限制条件，供前端和运营排查使用。
- 记录内容包含任务快照（避免任务后续被编辑导致历史记录失真）、候选集、每个候选的特征值、排序结果、规则版本、最终选择（选择结果在 [[9.dispatch-and-acceptance]] 完成分配后回填）。

### 模块 4: 候选列表前端

**涉及层及关键设计:**

- 列表模式为 MVP 必须实现的展示形式；脑图可视化按开放问题暂不纳入本次任务清单。
- 候选卡片展示字段与 `JobDistributionRecord.candidate_set` 中的特征值一一对应，不额外发起字段级请求，减少前端与后端候选集合不一致的风险。

## 接口契约

- 内部：`RunMatching(taskId) JobDistributionRecord`（幂等键：`taskId + task更新时间戳`，避免任务未变更时的重复无意义匹配，具体幂等策略见风险点）。
- `GET /api/tasks/:id/candidates`：返回最新一次 `JobDistributionRecord` 的候选集合与匹配理由。
- `PATCH /api/tasks/:id/match-criteria`：仅在「待匹配」状态允许发布者调整分类、受控标签或截止时间；预算与币种因已托管保持锁定。成功后递增任务版本并原子写事件、审计和幂等响应。
- `POST /api/tasks/:id/rematch`：任务修改后触发重新匹配（仅任务处于「待匹配」状态时允许）。

## 数据模型

- `job_distribution_records(id PK, task_id FK, task_snapshot JSONB, candidate_set JSONB, filter_reasons JSONB, feature_values JSONB, ranking_result JSONB, rule_version, final_selection_agent_id, created_at)`
- `ranking_rule_versions(id PK, version, weights JSONB, created_at, deprecated_at)`

## 安全考虑

- `task_snapshot` 中不包含任务的私密敏感字段之外的信息泄漏风险；候选集合展示的 Agent 信息遵循 [[7.task-visibility-and-mode]] 的脱敏原则，不展示 Agent 未公开的内部字段（如凭证配置状态之外的细节）。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：候选匹配相关的强调色使用 violet（`primary`，规范中专门保留给「AI、Agent 匹配、推荐」语义），cyan（`secondary`）只稀疏用于实时协议状态，不与托管/成功状态的 teal、green 混用。候选卡片中的报价、评分、历史完成量等数值右对齐排列以便扫描比较；`[v2]` 新入驻标识（受控上线期）复用 [[3.agent-health-lifecycle]] 定义的样式，不重新设计一套。列表模式需满足移动端和无障碍访问（PRD §8.2 要求）。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 匹配管道位置 | Go 分发引擎（选中）vs 业务服务 | 匹配需要读取 Agent 实时状态，与状态机权威数据同进程可避免额外的服务间往返和一致性问题 |
| 标签检索存储 | PostgreSQL（选中）vs 引入 pgvector/Qdrant | PRD 明确要求初期不为标签检索单独引入新数据库；V0 是精确匹配和规则排序，不需要向量检索能力 |
