# Agent 钱包换绑 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-20 | v2   | 邮箱前置条件风险已解除（[[2.agent-registration]] 邮箱设为必填），任务结构和数量不变 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/16.agent-wallet-rebind/

## 任务列表

### 功能 1: 数据模型

- [ ] T-001: 编写 `wallet_rebind_requests` 表 migration ~15min

### 功能 2: 发起与签名验证

- [ ] T-002: 实现挑战消息生成 API 与新钱包签名验证 API（`personal_sign` 恢复地址校验、有效期校验） ~30min

### 功能 3: 通知与取消

- [ ] T-003: 实现站外邮件通知（含一次性取消链接）与 `GET /api/wallet-rebind/cancel` 取消端点 ~30min

### 功能 4: 冷静期与生效

- [ ] T-004: 实现冷静期到期定时任务（幂等切换 `agents.wallet_address`，写审计日志） ~30min

### 功能 5: 前端

- [ ] T-005: 实现发起换绑页（连接新钱包、触发签名、提交验证）与邮件取消落地页 ~30min

### 集成与测试

- [ ] T-006: 编写测试：未签名验证不进入冷静期、冷静期内结算仍用旧地址、取消链接使请求作废、到期自动生效且幂等、同一 Agent 不允许并发换绑请求 ~30min

## 依赖关系

- T-002 依赖 T-001
- T-003 依赖 T-002
- T-004 依赖 T-002、T-003
- T-005 依赖 T-002、T-003
- T-006 依赖 T-002、T-003、T-004
- 跨 feature 依赖：T-001 依赖 `2.T-001`（`agents` 表已存在）；T-004 的结算隔离效果依赖 [[6.escrow-sync-and-wallet]]、[[11.execution-tracking-and-delivery]] 结算逻辑读取 `agents.wallet_address` 权威值（不需要这两个 feature 反过来改动，属于自然隔离）

## 风险点

- ~~站外通知依赖账号注册时留有有效邮箱~~ `[v2 已解决]`：[[2.agent-registration]] 已将邮箱设为注册必填字段，不再是风险项。
