# 五维评分系统 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-23 | v2   | 完成评分证据、系统响应时间、生产定时快照和正式前端验收 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/12.scoring-system/

## 任务列表

### 功能 1: 数据模型

- [x] T-001: 编写 `task_ratings`、`agent_score_snapshots`、`scoring_rule_versions` 表 migration ~30min

### 功能 2: 发布者评分

- [x] T-002: 实现 `POST /api/tasks/:id/rating`（仅验收后可提交一次，校验发布者身份） ~30min

### 功能 3: 系统计算

- [x] T-003: 实现争议率计算（只计仲裁确认责任事件，撤销/无责不扣分） ~30min
- [x] T-004: 实现历史完成规模计算（对数缩放，非归一化） ~15min
- [x] T-005: 实现贝叶斯平滑与时间衰减算法（`ComputeAgentScoreSnapshot`，可配置权重） ~30min

### 功能 4: 快照与展示

- [x] T-006: 实现评分快照定时计算任务 ~30min
- [x] T-007: 实现 `GET /api/agents/:id/score` 与前端评分展示（含样本量提示） ~30min

### 集成与测试

- [x] T-008: 编写测试：贝叶斯平滑对新 Agent 的抑制效果、争议撤销不扣分、系统计算项无写接口、规则版本可追溯 ~30min

## 依赖关系

- T-002 依赖 T-001
- T-003、T-004、T-005 依赖 T-001
- T-006 依赖 T-003、T-004、T-005
- T-007 依赖 T-002、T-006
- T-008 依赖 T-002~T-006
- 跨 feature 依赖：T-003 依赖 `13.T-004`（仲裁结果已确定）；T-002 依赖 `11.T-005`（任务已验收）

## 风险点

- 五维权重、贝叶斯先验参数均为占位默认值（见 requirements.md 开放问题），产品确认前不应作为最终排序依据向用户传达「精确权威分数」的印象，前端展示文案需体现这一点。

## 验收证据（2026-08-23）

- `0019_scoring_snapshot_evidence`、`0020_subjective_rating_boundary` 在真实 PostgreSQL
  测试库完成 up/down/up；819 个历史快照均回填规则对应的输入 ID 与系统响应时间。
- 发布者接口只接受质量与沟通两项主观输入；响应时间由 `task_assignments` 时间戳计算，
  争议率、完成规模和响应时间均不存在提供者写入口。
- CDK synth 已生成每小时 EventBridge Rule、POST API Destination、3 次重试和 Secrets
  Manager 动态引用；Rule Input 只有 `{ "limit": 100 }`，不含内部 token。
- Business API 全量：117 个套件成功，248 项通过、0 失败、1 项 Anvil 适配器因未提供
  `ANVIL_RPC_URL` 跳过；Web 全量 27 个文件、84 项通过；两端生产构建通过。
