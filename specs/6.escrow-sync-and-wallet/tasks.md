# 链上事件同步与钱包交互 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-23 | v2   | T-007 使用 wagmi 管理钱包生命周期、viem 处理链与交易类型，保留项目自有连接界面 |
| 2026-08-23 | v3   | T-007 增加交易已广播但平台登记失败的恢复路径，禁止误导用户重复发送资金 |
| 2026-08-23 | v4   | 补充 MetaMask 真实浏览器证据、RFC 3339 跨服务时间契约与托管三态显示时序 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/6.escrow-sync-and-wallet/

## 任务列表

### 功能 1: 数据模型

- [x] T-001: 编写 `escrow_sync`、`chain_event_cursor`、`reconciliation_alerts`、`refund_attempts` 表 migration ~30min

### 功能 2: 事件监听与确认

- [x] T-002: 实现区块高度轮询与事件写入（`(tx_hash, log_index)` 唯一约束去重），并实现确认数校验与状态迁移触发（调用 `TransitionTaskStatus`） ~30min
- [x] T-003: 实现 Reorg 检测逻辑（复核已处理区块哈希） ~30min

### 功能 3: 对账与失败恢复

- [x] T-004: 实现定时对账任务（链下记录 vs 合约 `escrowOf`，写入告警） ~30min
- [x] T-005: 实现退款失败重试逻辑（退避策略、尝试次数记录、达到上限转人工） ~30min
- [x] T-006: 实现 `GET /api/tasks/:id/escrow-status`、`POST /api/tasks/:id/escrow/retry` ~15min

### 功能 4: 前端钱包交互

- [x] T-007: 实现 MetaMask 连接与 `deposit` 交易发起（wagmi + viem），并展示交易状态（待确认/已确认/失败 + 重试入口） ~30min

### 集成与测试

- [x] T-008: 编写测试：重复事件幂等、确认阈值生效、对账不一致检测、退款失败保持可重试 ~30min

## 依赖关系

- T-002、T-003 依赖 T-001
- T-004 依赖 T-002；T-005 依赖 T-001
- T-006 依赖 T-002、T-005
- T-007 依赖 T-006
- T-008 依赖 T-002~T-006
- 跨 feature 依赖：T-002 依赖 `4.T-001`（任务状态机）与 `5.T-008`（合约已部署，ABI 可用）

## 风险点

- 生产确认数已改为部署必填配置；主网上线前仍需用真实网络条件验证 6 次确认的延迟与重组风险，高金额任务可能需要更高阈值。
- Reorg 检测逻辑（T-003）在测试网上较难自然复现，需要用本地链模拟工具（如 Hardhat 的分叉/回滚能力）构造测试场景。

## T-007 验收证据（2026-08-23）

- `web/apps/web/src/lib/wallet/wagmi-config.ts` 集中声明 Anvil、Sepolia、主网和 MetaMask connector；`wallet-session.ts` 使用 wagmi actions 连接、切链和发送交易，并由 viem 校验地址、hex 与 chain id。
- `escrow-deposit-flow.ts` 将准备、钱包广播和平台登记建模为三个交易阶段；取得 txHash 后若登记失败，只允许恢复同一 txHash，不再调用 MetaMask。登记完成后立即返回，页面先展示确认中；本地链只在用户刷新状态时推进确认，正式网络仍只读取真实区块。
- Web 针对性测试 3 个文件 / 27 项通过，覆盖错账户/错链、真实交易参数、待确认/失败展示、钱包拒签、登记恢复不重复发送、RFC 3339 时区偏移和“先展示确认中”时序；Web 全量 29 个文件 / 94 项通过，类型检查与生产构建通过。
- 在 Chain ID 31337 的真实 Anvil 上部署 `Escrow`，发送 2 个测试 ETH 的 `deposit(bytes32)` 成功；Business API 的 `escrow-anvil.integration.test.ts` 读取真实 `Deposited` receipt、事件字段和 `escrowOf` 记录通过（1/1）。
- `escrow-postgres.integration.test.ts` 在本地 PostgreSQL 测试库 5/5 通过；其中真实验证金额不一致时写入未解决告警并冻结操作，以及退款失败保持 `retry_pending` 、超过上限后转人工处理，对应 AC-004/AC-005。
- MetaMask 真实浏览器验收使用钱包 `0x5b103f5178F35ef3196bbc12810d7E0B264C02B4`、Anvil Chain 31337 与任务 `cdc22741-00ad-470a-9969-82e9606b3baa`：首次人工取消后页面展示“可重试”与 `0/12`；重试批准后交易 `0x869e3648d3f5ae3c10d6ab7fc56e23f9ac1ecb39b7c0794f65622d5daad65089` 回执 `status=0x1`，合约事件金额为 `0.0128 ETH`，页面展示“已确认”、`13/12` 并进入 `matching`。

## 2026-08-24 确认体验优化

- 首页与托管主操作不再暴露固定区块数，只展示“链上确认后自动开始匹配”；底层状态仍保留确认进度、重组检测和人工复核。
- 本地 Anvil 与测试链默认 2 次确认，Ethereum 主网开发默认 6 次；生产缺少显式阈值时启动失败。此前 `0/12`、`13/12` 记录是改动前的真实验收证据，保留用于追溯。
