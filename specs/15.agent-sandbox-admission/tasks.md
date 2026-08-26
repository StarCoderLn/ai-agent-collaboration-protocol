# 新 Agent 沙箱准入 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-24 | v2   | Feature 重新开始；T-001/T-002 实现并验证，T-003 起等待 14.T-001 RBAC |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/15.agent-sandbox-admission/

## 任务列表

### 功能 1: 数据模型与测试模板

- [x] T-001: 编写 `sandbox_test_templates`、`sandbox_test_runs`、`sandbox_evaluations` 表 migration，并录入 MVP 通用清单模板 ~30min

### 功能 2: 沙箱调用执行

- [x] T-002: 实现 `RunSandboxTest()`（触发 3 次调用，`call_type=sandbox`，写入产出与技术指标） ~30min

### 功能 3: 清单判定与准入

- [ ] T-003: 实现 `POST /api/admin/agents/:id/sandbox-evaluation`（结构化清单判定、写审计） ~30min
- [ ] T-004: 实现判定通过后调用 `TransitionAgentStatus`（`AdminApprove`，`reason` 引用判定记录 ID）与未通过的重试入口 `POST /api/agents/:id/sandbox-retry` ~30min

### 功能 4: 前端

- [ ] T-005: 实现运营沙箱结果查看与清单勾选页（3 次调用并排对比，checkbox 清单） ~30min

### 集成与测试

- [ ] T-006: 编写测试：判定全部通过触发准入、未通过保持试运行、沙箱调用不产生真实任务/资金记录、重复发起沙箱测试幂等 ~30min

## 依赖关系

- T-002 依赖 T-001
- T-003 依赖 T-001；T-004 依赖 T-003
- T-005 依赖 T-003、T-004
- T-006 依赖 T-002、T-003、T-004
- 跨 feature 依赖：T-002 依赖 `1.T-008`（沙箱标记位）与 `2.T-003`（Agent 基础注册完成）；T-003 依赖 `14.T-001`（`RequirePermission` 角色权限）；T-004 依赖 `3.T-004`（`TransitionAgentStatus` 的 `AdminApprove` 事件已存在）

## 风险点

- 分类专属测试任务模板未定（见 requirements.md 开放问题），MVP 用通用模板覆盖全部分类，可能对专业性强的分类（如合约审计类 Agent）判别力不足，后续需要产品/运营按分类补充专属模板，属于数据补充而非结构变更。
- 若 feature 14 的 RBAC 尚未完成，T-003 必须等待 `RequirePermission()`，不得用可绕过权限的临时占位入口冒充完成。

## 当前未完成原因（2026-08-24）

- T-003 的明确跨 feature 依赖 `14.T-001 RequirePermission()` 仍未完成；为避免留下可绕过运营权限的临时判定入口，本轮不使用权限占位。
- T-004、T-005 依赖 T-003，暂不提前实现；T-006 包含 T-003/T-004 的准入判定场景，因此仍保持未勾选。T-002 已覆盖三次调用、沙箱签名、同轮幂等、技术失败、租约恢复和正式业务表隔离测试。
