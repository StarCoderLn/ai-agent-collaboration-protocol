# 运营后台与核心指标 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（RBAC、查询 API、指标聚合）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 角色权限体系（RBAC）

**涉及层及关键设计:**

- `roles` + `user_roles` 表 + 静态的「角色 → 权限点」映射（代码中定义，不做动态可配置权限点管理，避免为未经确认的需求建立框架）。
- 提供统一的权限校验中间件 `RequirePermission(permissionKey)`，本 feature 定义的权限点供 [[3.agent-health-lifecycle]] 的审核接口、[[13.dispute-and-arbitration]] 的仲裁决定接口等复用，是唯一的权限校验实现，不允许各 feature 各自判断角色字符串。
- 高风险操作二次确认作为通用前端交互组件 + 后端要求请求体携带 `confirmationToken`（由「预览接口」生成，短时有效），避免仅靠前端弹窗这种可绕过的伪二次确认。

### 模块 2: 运营查询

**涉及层及关键设计:**

- 任务查询、派发失败查询、超时处理、交易核对四类查询直接读取各自权威表（`tasks`、[[9.dispatch-and-acceptance]] 的 `dispatch_attempts`、[[11.execution-tracking-and-delivery]] 的超时状态、[[6.escrow-sync-and-wallet]] 的 `reconciliation_alerts`），本模块不复制这些数据到独立的运营专用表，避免数据双写不一致。

### 模块 3: 指标埋点与聚合

**涉及层及关键设计:**

- 六项 MVP 成功指标的原始事件来自已有的 `task_events`（[[10.notification-and-sync]]）与各状态迁移记录，本模块只负责定义指标计算口径与每日聚合任务，不重新采集数据。
- `metrics_daily(date, metric_key, value, sample_size)` 存储预聚合结果，看板直接查询该表。

## 接口契约

- `GET /api/admin/tasks?status=&hasFailure=`：运营任务查询。
- `GET /api/admin/dispatch-failures`、`GET /api/admin/reconciliation-alerts`：复用下游 feature 数据源的只读查询。
- `POST /api/admin/high-risk-actions/:type/confirm`：生成二次确认 token（预览高风险操作影响后调用）。
- `GET /api/admin/audit-logs?actor=&target=&from=&to=`：审计日志查询。
- `GET /api/admin/metrics?from=&to=`：指标看板数据。

## 数据模型

- `roles(id PK, name)`，`user_roles(user_id, role_id)`。
- `metrics_daily(date, metric_key, value, sample_size, computed_at)`，主键 `(date, metric_key)`。
- 复用：`audit_logs`（[[2.agent-registration]]）、`dispatch_attempts`（[[9.dispatch-and-acceptance]]）、`reconciliation_alerts`（[[6.escrow-sync-and-wallet]]）。

## 安全考虑

- `RequirePermission` 中间件是全平台高风险操作的统一守门实现，任何新增的运营/仲裁类接口都必须显式声明所需权限点，代码评审需检查是否遗漏。
- 二次确认 token 需短时有效且一次性使用，防止被截获重放触发未经确认的高风险操作。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：运营后台使用数据密集但克制的表格/卡片布局，不引入规范之外的新配色。高风险操作的二次确认弹窗使用 error 语义强调不可逆后果，明确展示操作对象、影响范围（符合 AGENTS.md「高风险操作明确展示对象、金额、状态、后果和不可逆性」）。指标看板图表沿用规范的语义色板，不为图表单独定义一套配色系统。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 权限模型复杂度 | 静态角色→权限点映射（选中）vs 可配置动态权限系统 | PRD 明确标注权限分级与审批方式待确认，构建动态权限系统属于为未经确认的需求建立框架，先用静态映射满足 MVP，需要时再升级 |
| 运营查询数据来源 | 直读权威表（选中）vs 独立运营专用宽表 | 独立宽表需要额外的同步机制，在 MVP 阶段引入数据双写不一致的风险，收益不足以覆盖成本 |
