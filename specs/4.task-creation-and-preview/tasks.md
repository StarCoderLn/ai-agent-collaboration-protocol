# 任务创建与发布预览 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-20 | v2   | T-001 migration 新增 `attachment_category_limits` 表；T-003/T-004 校验规则纳入按分类的附件大小/类型上限；T-008 增补对应测试；任务结构和数量不变 |
| 2026-08-20 | v3   | T-001 migration 新增 `platform_fee_config` 表；T-005 实现 `CalculatePlatformFee()`；T-008 增补手续费下限测试；任务结构和数量不变 |
| 2026-08-20 | v4   | T-001 migration 新增 `task_timing_config` 表（默认 30 分钟）；T-003 校验规则改读配置值；T-008 增补测试；任务结构和数量不变 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/4.task-creation-and-preview/

## 任务列表

### 功能 1: 状态机与数据模型

- [ ] T-001: 定义任务主状态机（全部状态与异常分支的迁移表，可辨识联合）与 `TransitionTaskStatus()`，并编写 `tasks`、`categories`、`tags`、`[v2]` `attachment_category_limits`、`[v3]` `platform_fee_config`、`[v4 新增]` `task_timing_config`（默认 `min_execution_period_seconds=1800`）表 migration ~30min

### 功能 2: 分类标签服务

- [ ] T-002: 实现分类树查询与标签建议/同义词归一 API ~30min

### 功能 3: 创建任务 API

- [ ] T-003: 实现共享校验规则定义（截止时间/预算区间/固定价/标签禁用词、`[v2]` 按分类的附件大小/类型上限查询、`[v4]` 截止时间下限改读 `task_timing_config`） ~30min
- [ ] T-004: 实现 `POST /api/tasks`、`PATCH /api/tasks/:id`、`POST /api/tasks/:id/submit`（`[v2]` 接入附件上限校验，超限返回具体分类上限提示） ~30min
- [ ] T-005: 实现 `CalculatePlatformFee()`（`[v3 新增]`，唯一权威手续费计算函数）与 `GET /api/tasks/:id/preview` 预览接口（费用计算、不可逆提示） ~30min

### 功能 4: 前端

- [ ] T-006: 实现创建任务表单（五组分区、分类标签联动、固定价/区间独立控件） ~30min
- [ ] T-007: 实现发布预览页 ~15min

### 集成与测试

- [ ] T-008: 编写测试：截止时间/预算区间/标签禁用词校验、草稿→待托管迁移合法性、`[v2]` 超过分类附件上限被拒绝、调整配置表后新上传立即按新值生效、可执行文件类型始终被拒绝、`[v3]` 极低价任务手续费按 gas 成本兜底计算、正常任务按 0.4% 计算、预览与结算引用同一 `CalculatePlatformFee()` 结果一致、`[v4 新增]` 截止时间短于 30 分钟被拒绝、调整 `task_timing_config` 后新提交立即按新值校验 ~30min

## 依赖关系

- T-003、T-004、T-005 依赖 T-001
- T-004 依赖 T-002（标签校验）、T-003
- T-006 依赖 T-004；T-007 依赖 T-005
- T-008 依赖 T-004、T-005

## 风险点

- 任务主状态机是多个后续 feature 的共享基础，若其迁移表设计遗漏某个异常分支，后续 feature 需要回来扩展而非新建状态机，需在 T-001 评审时对照 PRD §6.1 全部分支逐条核对。
