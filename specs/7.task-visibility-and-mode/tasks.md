# 任务可见性与分配模式 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-20 | v2   | T-004 增加受控上线期预算上限判断（调用 [[3.agent-health-lifecycle]] 的 `IsInProbation()`）；T-008 增补对应测试；任务结构和数量不变 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/7.task-visibility-and-mode/

## 任务列表

### 功能 1: 可见性脱敏

- [ ] T-001: 实现 `RedactTaskForAudience()` 权威脱敏函数与私密任务访问权限校验 ~30min
- [ ] T-002: 接入市场列表、详情、发布者预览三个接口，统一调用 T-001 ~30min

### 功能 2: 分配模式与验收模式

- [ ] T-003: 扩展 `tasks` 表字段（`assignment_mode_config`、`acceptance_mode`、`acceptor_config`）migration ~15min
- [ ] T-004: 实现 `ValidateHardConstraints()` 硬约束声明函数（预算/健康状态/准入状态/截止时间/`[v2 新增]` 受控上线期预算上限）与验收模式前置校验 ~30min
- [ ] T-005: 实现 `PATCH /api/tasks/:id/mode-settings`（含接单后锁定、审计日志写入） ~30min

### 功能 3: 前端

- [ ] T-006: 实现公开任务市场页（关键词/分类/标签/状态筛选） ~30min
- [ ] T-007: 实现「我的任务」工作台页（独立统计口径） ~30min

### 集成与测试

- [ ] T-008: 编写测试：私密任务越权访问拒绝、脱敏字段一致性、接单后锁定模式变更、自动验收前置条件、`[v2 新增]` 受控上线期 Agent 超预算被排除、非受控期 Agent 不受此约束影响 ~30min

## 依赖关系

- T-002 依赖 T-001
- T-004、T-005 依赖 T-003
- T-006 依赖 T-002；T-007 独立可并行
- T-008 依赖 T-002、T-004、T-005
- 跨 feature 依赖：T-003 依赖 `4.T-001`（`tasks` 表已存在）；`[v2 新增]` T-004 依赖 `3.T-001`（`agent_status_config` 表含 `probation_budget_cap_percentile`）与 `12.T-001`（`agent_score_snapshots`/`scoring_rule_versions` 表结构已存在——**只依赖表结构，不依赖 12 的评分计算逻辑跑完**：`IsInProbation()` 查不到快照时按 `sample_size=0` 处理，本身就是合法的"受控中"结果，不需要等 12 产出真实评分数据才能开发和测试本任务）

## 风险点

- `RedactTaskForAudience` 一旦被绕过（新接口直接序列化任务实体）将造成信息泄漏，需要在代码评审清单中固化检查项，而非仅依赖测试覆盖。
