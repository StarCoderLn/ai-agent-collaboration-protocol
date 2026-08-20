# 链上事件同步与钱包交互 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/6.escrow-sync-and-wallet/

## 任务列表

### 功能 1: 数据模型

- [ ] T-001: 编写 `escrow_sync`、`chain_event_cursor`、`reconciliation_alerts`、`refund_attempts` 表 migration ~30min

### 功能 2: 事件监听与确认

- [ ] T-002: 实现区块高度轮询与事件写入（`(tx_hash, log_index)` 唯一约束去重），并实现确认数校验与状态迁移触发（调用 `TransitionTaskStatus`） ~30min
- [ ] T-003: 实现 Reorg 检测逻辑（复核已处理区块哈希） ~30min

### 功能 3: 对账与失败恢复

- [ ] T-004: 实现定时对账任务（链下记录 vs 合约 `escrowOf`，写入告警） ~30min
- [ ] T-005: 实现退款失败重试逻辑（退避策略、尝试次数记录、达到上限转人工） ~30min
- [ ] T-006: 实现 `GET /api/tasks/:id/escrow-status`、`POST /api/tasks/:id/escrow/retry` ~15min

### 功能 4: 前端钱包交互

- [ ] T-007: 实现 MetaMask 连接与 `deposit` 交易发起（wagmi/viem），并展示交易状态（待确认/已确认/失败 + 重试入口） ~30min

### 集成与测试

- [ ] T-008: 编写测试：重复事件幂等、确认阈值生效、对账不一致检测、退款失败保持可重试 ~30min

## 依赖关系

- T-002、T-003 依赖 T-001
- T-004 依赖 T-002；T-005 依赖 T-001
- T-006 依赖 T-002、T-005
- T-007 依赖 T-006
- T-008 依赖 T-002~T-006
- 跨 feature 依赖：T-002 依赖 `4.T-001`（任务状态机）与 `5.T-008`（合约已部署，ABI 可用）

## 风险点

- 确认数阈值当前为占位默认值（见 requirements.md 开放问题），影响 AC-006 的实际延迟表现，需上线前用真实网络条件复测。
- Reorg 检测逻辑（T-003）在测试网上较难自然复现，需要用本地链模拟工具（如 Hardhat 的分叉/回滚能力）构造测试场景。
