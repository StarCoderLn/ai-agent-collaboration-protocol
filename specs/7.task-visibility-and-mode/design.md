# 任务可见性与分配模式 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 模块 2 的 `ValidateHardConstraints` 新增受控上线期预算上限判断，实现 [[3.agent-health-lifecycle]] 定义的 `IsInProbation()` |
| 2026-08-31 | v3   | 取消整单预算候选过滤；受控上线期风险门禁改为比较 Agent 自身报价 |
| 2026-09-04 | v4   | 冷启动门禁改读真实结算任务数；评分样本仅用于置信度 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（Next.js + AWS Lambda）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 可见性与字段脱敏

**涉及层及关键设计:**

- 单一权威的字段脱敏函数 `RedactTaskForAudience(task, audience)`，`audience` 为 `publisher | assignedAgent | authorizedOps | public | unauthenticated`；市场列表接口、详情接口、发布者预览接口全部调用同一函数，禁止各自维护字段白名单（AGENTS.md §9「同一业务规则只保留一个权威实现」）。
- 私密任务对 `public`/`unauthenticated` 之外的所有 `audience` 校验通过后才返回数据；非法访问返回统一的「无权限」错误，不泄露任务是否存在。

### 模块 2: 分配模式配置与硬约束声明

**涉及层及关键设计:**

- `assignment_mode_config` 存储在 [[4.task-creation-and-preview]] 定义的 `tasks` 表扩展字段：`{ enabled: boolean, priceCap: Amount, rankingBasis: string, fallbackOnFail: "manual" | "cancel" }`。
- 硬约束声明为纯函数 `ValidateHardConstraints(candidate, task) -> reason`（健康状态、准入状态、币种、截止时间和冷启动报价上限），供 [[8.matching-and-candidates]] 生成候选集合。发布者整单预算不再作为布尔资格条件，报价差异通过排序和准确总价比较呈现。
- `[v4]` 风险门禁读取 `settledTaskCount`、`probation_completed_task_threshold` 与 `probation_budget_cap_percentile`；真实结算数未达阈值且 `candidate.price > probationCap` 时返回 `probation_budget_exceeded`。`priorWeight` 仍随候选快照用于评分置信度，但不进入资金门禁。

### 模块 3: 验收模式

**涉及层及关键设计:**

- `acceptance_mode`（`manual` 默认 / `auto`）+ `acceptor_config`（可为空，非空时才允许 `auto`）。
- 提交任务或修改验收模式时校验：`acceptance_mode = auto` 必须伴随非空 `acceptor_config`，否则拒绝，从数据完整性层面防止「无验收器却自动放款」。

### 模块 4: 变更限制

**涉及层及关键设计:**

- 可见性/分配模式/验收模式的变更统一走 `UpdateTaskModeSettings()`，内部先检查任务状态是否已进入「执行中」及之后（代表已接单），已接单则拒绝并返回明确错误；变更成功写入 [[2.agent-registration]] 定义的共享 `audit_logs` 表。

### 模块 5: 前端页面

**涉及层及关键设计:**

- 市场页与工作台页调用不同的统计接口（`GET /api/market/stats` vs `GET /api/my-tasks/stats`），避免共用一个聚合查询导致口径纠缠。

## 接口契约

- `GET /api/market/tasks?keyword=&category=&tag=&status=`：仅返回 `visibility = public` 的任务，字段经 `RedactTaskForAudience` 处理。
- `GET /api/tasks/:id?audience=`：详情接口按 `audience` 返回不同字段集合。
- `PATCH /api/tasks/:id/mode-settings`：更新可见性/分配模式/验收模式，已接单任务返回 `TASK_MODE_LOCKED` 错误码。
- `GET /api/my-tasks/stats`、`GET /api/market/stats`：独立统计接口。

## 数据模型

- 扩展 [[4.task-creation-and-preview]] 的 `tasks` 表：`visibility`、`assignment_mode_config JSONB`、`acceptance_mode`、`acceptor_config JSONB`。
- 复用共享 `audit_logs` 表记录模式变更。

## 安全考虑

- `RedactTaskForAudience` 是唯一允许对外输出任务字段的路径，任何新增的任务查询接口必须复用它，代码评审需检查是否绕过该函数直接序列化任务实体。
- 硬约束校验函数 `ValidateHardConstraints` 的输入不信任调用方预先过滤好的候选集合，函数内部重新校验，防止调用方遗漏约束。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：可见性（私密/公开）与分配模式（手动/自动）的标签使用中性色 tag，不借用 success/error 等强语义色（这不是对错判断，是配置状态）。市场页与工作台页的统计卡片沿用同一套卡片样式（12px 圆角、8px 间距），但数据来源不同（见「技术决策」）；任务列表可选展示任务 ID 时使用等宽字体。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 字段脱敏实现方式 | 单一权威函数（选中）vs 各接口独立实现 White-list | 独立实现容易在新增字段时遗漏某个接口的脱敏规则，历史上是常见的信息泄漏根因（AGENTS.md 明确要求集中权威实现） |
| 硬约束校验位置 | 声明在本 feature、执行在 feature 8（选中）vs 完全下沉到 feature 8 独立实现 | 约束规则属于「任务分配模式」的业务知识，应与配置定义放在一起，避免匹配算法（feature 8）反向定义业务规则 |
