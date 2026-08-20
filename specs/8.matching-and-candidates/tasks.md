# V0 匹配与候选列表 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-20 | v2   | T-007 措辞由"试运行标识"改为"新入驻标识"；任务结构和数量不变 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/8.matching-and-candidates/

## 任务列表

### 功能 1: 数据模型

- [ ] T-001: 编写 `job_distribution_records`、`ranking_rule_versions` 表 migration ~15min

### 功能 2: 匹配管道

- [ ] T-002: 实现 `FilterByCategory` 与 `FilterByEligibility`（复用 `7.ValidateHardConstraints`） ~30min
- [ ] T-003: 实现 `MatchByTags` 标签匹配 ~30min
- [ ] T-004: 实现 `RankByRules` 规则排序（纯函数，读取 `ranking_rule_versions`） ~30min

### 功能 3: 记录与 API

- [ ] T-005: 实现 `JobDistributionRecord` 生成与持久化（含无候选场景的 `filter_reasons`） ~30min
- [ ] T-006: 实现 `GET /api/tasks/:id/candidates`、`POST /api/tasks/:id/rematch` ~30min

### 功能 4: 前端

- [ ] T-007: 实现候选列表页（列表模式，匹配标签/报价/时长/评分/历史完成量/新入驻标识） ~30min

### 集成与测试

- [ ] T-008: 编写测试：可复现性（同输入同版本结果一致）、资格过滤排除、无候选场景提示 ~30min

## 依赖关系

- T-002、T-003、T-004 依赖 T-001
- T-005 依赖 T-002、T-003、T-004
- T-006 依赖 T-005
- T-007 依赖 T-006
- T-008 依赖 T-005、T-006
- 跨 feature 依赖：T-002 依赖 `7.T-004`（`ValidateHardConstraints`）；T-005 依赖 `3.T-001`（Agent 状态机，读取 `active` 状态）与 `6.T-002`（任务已确认进入「待匹配」）

## 风险点

- 排序权重为占位默认值（见 requirements.md 开放问题），产品确认后需要重新评估排序结果是否符合预期，但不影响管道结构。
- 匹配重跑的幂等策略（避免任务未变更时的重复计算）需要在 T-005 实现时明确：以任务的 `updated_at` 作为触发依据，同一 `updated_at` 不重复生成新记录。
