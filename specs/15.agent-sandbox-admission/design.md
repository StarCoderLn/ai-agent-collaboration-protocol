# 新 Agent 沙箱准入 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-24 | v2   | T-001/T-002 落地：增加轮次幂等、三槽位租约恢复与独立沙箱执行模块 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，沙箱调用执行，复用 [[1.agent-protocol-contract]]）、交易/业务服务（测试模板管理、清单判定 API）、PostgreSQL、前端

## 功能模块设计

### 模块 1: 测试任务模板

**涉及层及关键设计:**

- `sandbox_test_templates` 按能力分类（复用 [[4.task-creation-and-preview]] 的 `categories`）存储固定测试输入和判定清单项列表，版本化（同一分类的模板更新后，已进行中的沙箱测试仍使用发起时的模板版本，不因模板更新而中途改变判定标准）。
- MVP 先提供一份通用清单模板作为所有分类的默认值（见 requirements.md 开放问题），分类专属模板作为后续可插入的数据，不影响流程代码。

### 模块 2: 沙箱调用执行

**涉及层及关键设计:**

- Agent 通过 [[2.agent-registration]] 的基础注册审核后，Go 分发引擎以稳定 `round_id` 触发一轮 3 次调用，每次调用复用 [[1.agent-protocol-contract]] 的 `Sign(req, secret, "sandbox")`，请求体为模板中的固定测试输入。三次逻辑调用分别使用 `sandbox:{round_id}:1..3` 幂等键；进程恢复继续使用原键，提供者修复后的重测使用新 `round_id`。
- 调用产出（Agent 返回的结果引用）与技术指标（协议合规、延迟、报错分类）自动写入 `sandbox_test_runs`，这部分完全不需要人工参与，复用协议层已有的错误分类能力，不重新发明一套判断逻辑。
- 独立 `sandboxadmission` 模块只依赖沙箱仓储、凭证解密器和 Agent 调用器，不依赖任务、分配、评分或资金服务。每个 run 使用数据库租约防止并发重复执行；进程在响应落库前崩溃时允许租约到期恢复，但仍使用同一幂等键，因此语义是 3 个逻辑调用，而不是承诺跨网络的物理 exactly-once。
- MVP 把最多 1 MiB 的不可信响应编码为只存储、不执行的 `data:` 引用；后续可在模块内部替换成对象存储实现，不改变服务接口和表结构。

### 模块 3: 清单式人工判定

**涉及层及关键设计:**

- 判定 API 只接受"清单项 → 是/否"的结构化输入（`checked_items: { itemKey: boolean }`），不接受开放式评分或自由文本作为判定的唯一依据，从接口设计上防止判定退化为主观印象打分。
- 判定逻辑：清单项全部为「否"（即未命中任何负面项，如"未跑题""无报错""格式正确"）时判定为「通过」；单次沙箱调用判定完成后，需 3 次调用全部通过才触发准入。

### 模块 4: 准入决策整合

**涉及层及关键设计:**

- 3 次判定全部通过后，本模块调用 [[3.agent-health-lifecycle]] 暴露的 `TransitionAgentStatus(agentId, AdminApprove, actor)`，`reason` 字段固定填入本次判定记录的 ID，不允许自由文本替代，保证"为什么批准"始终可追溯到具体清单判定，而不是一句人工总结。
- 未全部通过：Agent 保持 `pending_review`（试运行）状态，提供者可在修复问题后主动请求重新发起一轮沙箱测试（复用模块 2，视为新一轮 3 次调用，不清除历史记录）。

### 模块 5: 前端

**涉及层及关键设计:**

- 运营查看页展示 3 次调用的产出物、技术指标和清单，逐项勾选，不提供"总体评分"输入框，界面结构本身引导运营做清单式判断而非印象打分。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：沙箱调用产出以卡片形式并排展示（3 次调用对比更容易），技术指标用中性 tag（协议合规/报错分类等），清单勾选项使用 checkbox 而非评分组件，强化"这是清单判断不是打分"的界面语义。判定结果（通过/不通过）用 success/warning 语义色，不用 error（未通过是可重试的中间态，不是失败）。

## 接口契约

- 内部：`RunSandboxTest(agentId, roundId) sandboxTestRound`（建立并执行一轮 3 次逻辑调用，均为 `call_type=sandbox`）。
- `GET /api/admin/agents/:id/sandbox-runs`：查看沙箱调用产出与技术指标。
- `POST /api/admin/agents/:id/sandbox-evaluation`：提交清单判定，请求体 `{ runIds: [...], checkedItems: {...} }`；全部通过时内部调用 `TransitionAgentStatus`。
- `POST /api/agents/:id/sandbox-retry`：提供者请求重新发起一轮沙箱测试（仅 `pending_review` 状态可调用）。

## 数据模型

- `sandbox_test_templates(id PK, category_id FK nullable, test_input JSONB, checklist_items JSONB, version, created_at, deprecated_at)`；`category_id=NULL` 是通用兜底模板。
- `sandbox_test_runs(id PK, agent_id FK, template_id FK, round_id, run_no, call_type, status, output_ref, technical_metrics JSONB, lock_token, locked_until, started_at, completed_at, created_at)`；唯一键为 `(agent_id, round_id, run_no)`。
- `sandbox_evaluations(id PK, agent_id FK, round_id, run_ids JSONB, reviewer_id, checked_items JSONB, decision, decided_at)`
- 状态迁移统一写入 [[2.agent-registration]] 定义的共享 `audit_logs` 表。

## 安全考虑

- 判定 API 需要运营角色权限校验（复用 [[14.ops-backend-and-metrics]] 的 `RequirePermission()`）。
- 沙箱调用不得触碰真实资金路径：`RunSandboxTest` 不创建 `tasks`/`task_assignments` 记录，也不经过 [[9.dispatch-and-acceptance]] 的派发链路，从代码路径上物理隔离，而不是靠业务规则约束。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 判定输入形式 | 结构化是/否清单（选中）vs 1-10 分打分 | 打分本质上仍是主观判断且不可复核（"7分"和"8分"的界限说不清）；是/否清单把判断拆成可复核的客观项，符合本 feature 存在的目的 |
| 准入触发方式 | 本 feature 调用 3 的 `TransitionAgentStatus`（选中）vs 3 直接轮询本 feature 的判定结果 | 由触发方主动调用比被动轮询更符合事件驱动的一致性模型，且避免 [[3.agent-health-lifecycle]] 反过来依赖本 feature 的内部表结构 |
