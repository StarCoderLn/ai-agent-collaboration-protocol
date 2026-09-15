# 链上事件同步与钱包交互 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-23 | v2   | T-007 使用 wagmi 管理钱包生命周期、viem 处理链与交易类型，保留项目自有连接界面 |
| 2026-08-23 | v3   | T-007 增加交易已广播但平台登记失败的恢复路径，禁止误导用户重复发送资金 |
| 2026-08-23 | v4   | 补充 MetaMask 真实浏览器证据、RFC 3339 跨服务时间契约与托管三态显示时序 |
| 2026-08-27 | v5   | 业务资产改为 USDC；两步钱包流程和新合约的真实闭环待重新验收 |
| 2026-08-28 | v6   | 完成 USDC MetaMask 人工验收；补充精确授权复用、回执等待和链事件恢复证据 |
| 2026-08-31 | v7   | T-007/T-008 增加钱包请求超时、不确定结果保护、失败登记限时和页面解锁回归；任务结构与勾选状态不变 |
| 2026-08-31 | v8   | T-002/T-006/T-008 同步冻结总价托管及确认后按 DAG 开放已选 Agent；任务结构与勾选状态不变 |
| 2026-08-31 | v9   | T-006/T-008 同步 intent 锁定边界与托管操作顺序；任务结构与勾选状态不变 |
| 2026-09-01 | v10  | T-007/T-008 修复 Anvil nonce 队列空洞并增加分阶段钱包进度；任务勾选状态不变 |
| 2026-09-01 | v11  | T-006/T-007/T-008 增加未广播托管放弃、失败后改选与旧金额登记防护；任务勾选状态不变 |
| 2026-09-02 | v12  | T-002/T-005/T-008 改为最终统一分账，并增加 DAO 仲裁摘要核验与专用退款恢复 |
| 2026-09-10 | v13  | 同步 Sepolia 钱包存款、项目加密 keystore 结算与争议退款验收；任务状态不变 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/6.escrow-sync-and-wallet/

## 任务列表

### 功能 1: 数据模型

- [x] T-001: 编写 `escrow_sync`、`chain_event_cursor`、`reconciliation_alerts`、`refund_attempts` 表 migration ~30min

### 功能 2: 事件监听与确认

- [x] T-002: 实现区块高度轮询与事件写入（`(tx_hash, log_index)` 唯一约束去重），并实现确认数校验与状态迁移触发；支持 `WorkflowSettled` / `DisputeRefunded` 摘要核验和争议解冻 ~30min
- [x] T-003: 实现 Reorg 检测逻辑（复核已处理区块哈希） ~30min

### 功能 3: 对账与失败恢复

- [x] T-004: 实现定时对账任务（链下记录 vs 合约 `escrowOf`，写入告警） ~30min
- [x] T-005: 实现统一结算与退款失败重试（先持久化签名交易、重播同一 raw transaction、退避、死信冻结和人工复核） ~30min
- [x] T-006: 实现 `GET /api/tasks/:id/escrow-status`、`POST /api/tasks/:id/escrow/retry`，并由准备接口只读取已确认 workflow run 的准确总价；未广播失败可放弃并改选，Deposit 登记绑定准备时金额；托管卡片位于 Agent 方案与报价之后 ~15min

### 功能 4: 前端钱包交互

- [x] T-007: 实现 MetaMask 精确授权 USDC 与 `deposit` 交易发起（wagmi + viem），并展示准备、授权、存入、登记和链上状态、两次签名的明确引导，以及扩展无响应时的有限等待、不确定结果保护和操作解锁；未广播的准备可显式放弃后重新选 Agent；本地 Anvil 显式使用 RPC pending nonce，测试网与主网继续由钱包管理 nonce ~30min

### 集成与测试

- [x] T-008: 编写测试：重复事件幂等、确认阈值、对账、重试/死信、钱包超时、本地 nonce，以及中间阶段不付款、最终多 Agent 原子分账、专用争议退款、摘要不一致拒绝确认和链确认后解冻 ~30min

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

## Sepolia 验收增量（2026-09-10）

- Circle Sepolia USDC 与新版 Escrow 已完成钱包存款；项目专用加密 keystore operator 已完成部分结算和争议全额退款，真实交易证据见 [DAO 奖励与链上仲裁](../../docs/dao-chain-arbitration.md)。
- 用户钱包继续由 MetaMask 管理 nonce；本机后台 operator 使用 Web3 Secret Storage 加密 keystore，并从 macOS Keychain 读取密码。该方案用于本机 Sepolia 验收，不能代替生产 KMS/HSM、密钥轮换、监控和恢复演练。

## T-007 验收证据（2026-08-23）

### USDC 自动化真实闭环（2026-08-28）

- 在真实 Anvil 31337 上部署 6 位测试 USDC 与新版 Escrow，默认发布者获得 100,000
  测试 USDC；Marketplace API 返回精确授权与存款两笔零原生 value 交易。
- 正常闭环任务 `88a9d64c-4365-4b01-b65d-b8587fa8c157` 已经过 SIWE、32 USDC
  授权/托管、匹配、真实 DeepSeek 执行、返工、验收、链上结算和评分，终态为
  `settled`，审计链包含 `task.escrow_confirmed` 与 `task.settlement_confirmed`。
- 争议闭环任务 `9a6f8cbd-319c-4cda-ab99-9cc138f63e02` 已经过独立发布者/仲裁员
  SIWE 身份、举证、全额退款裁决和链上退款，终态为 `refunded`，审计链包含
  `task.arbitration_refund_confirmed`。
- Web 全量 37 个文件 / 134 项测试、Marketplace API 268 项测试、真实 Anvil 适配器
  1 项测试与 Escrow Foundry 11 项测试均通过；三个 Node 应用生产构建与 Go 全量测试通过。
  以上证明系统闭环和资金不变量，但不等于用户在浏览器中确认过 MetaMask 两次签名
  的文案与交互，因此当时没有勾选 T-007；后续人工浏览器验收证据见下一节。

### USDC MetaMask 人工浏览器闭环（2026-08-28）

- 使用 MetaMask 钱包 `0x6de38F0f6f2CF0d133DB4ddbF143618bfF9EA83A`、Anvil
  Chain 31337 和任务 `e0b8258a-208e-4e22-978c-eb1aecc43506` 验收 32 USDC
  两步流程。用户先人工取消 USDC 支出上限请求；链上余额和 allowance 未变化，任务仍为
  `awaiting_escrow`，页面主操作恢复为可安全重试。
- 第二次人工确认精确授权后，链上 allowance 为 `32000000`。验收由此发现原实现没有
  等待授权回执、重试也会无条件重复授权；已改为先读取 allowance，额度恰好等于任务金额
  时复用，否则精确授权、等待成功回执并再次校验后才允许调用 `deposit`。
- 用户人工取消第一笔 `deposit` 后，钱包仍为 1,000 USDC、allowance 仍为 32 USDC、
  托管记录仍为 `prepared`，证明资金没有移动且可以复用授权重试。MetaMask 弹窗关闭时
  Chrome 控制会话同时断开，因此未把瞬时取消 Toast 记作人工可见证据；失败文案与重试
  面板由 `task-experience-detail.test.tsx` 和钱包流程单元测试独立验证。
- 最终重试跳过重复授权并由用户人工确认 `deposit`。交易
  `0x35d5e8d359406ef94c617053d48dfceddb0cafb90c61472bcce75d1ee9d11ca7`
  成功后，发布者余额为 968 USDC、Escrow 余额为 32 USDC、allowance 归零。浏览器上报
  被弹窗切换中断时，链同步 worker 仍从 `Deposited` 事件找回交易，页面先展示
  `pending_confirmation`，刷新后展示 `confirmed` 并进入 `matching`；数据库最终状态为
  `tasks.matching`、`escrow_intents.confirmed`、`escrow_sync.confirmed`（3 次确认）。
- 针对性 Web 测试 3 个文件 / 29 项通过，覆盖精确授权复用、等待授权回执、授权和存款
  拒绝、交易登记恢复、失败与重试面板；TypeScript 检查和 Web 生产构建通过。

### 迁移前 ETH 历史证据

> 以下是迁移前原生 ETH 方案的历史证据，只用于追溯，不能代替 USDC 两步交易的
> MetaMask 人工验收。只有浏览器中的两次签名、取消和重试均确认后才勾选 T-007。

- `web/apps/web/src/lib/wallet/wagmi-config.ts` 集中声明 Anvil、Sepolia、主网和 MetaMask connector；`wallet-session.ts` 使用 wagmi actions 连接、切链和发送交易，并由 viem 校验地址、hex 与 chain id。
- `escrow-deposit-flow.ts` 将准备、钱包广播和平台登记建模为三个交易阶段；取得 txHash 后若登记失败，只允许恢复同一 txHash，不再调用 MetaMask。登记完成后立即返回，页面先展示确认中；本地链只在用户刷新状态时推进确认，正式网络仍只读取真实区块。
- Web 针对性测试 3 个文件 / 27 项通过，覆盖错账户/错链、真实交易参数、待确认/失败展示、钱包拒签、登记恢复不重复发送、RFC 3339 时区偏移和“先展示确认中”时序；Web 全量 29 个文件 / 94 项通过，类型检查与生产构建通过。
- 在 Chain ID 31337 的真实 Anvil 上部署 `Escrow`，发送 2 个测试 ETH 的 `deposit(bytes32)` 成功；Marketplace API 的 `escrow-anvil.integration.test.ts` 读取真实 `Deposited` receipt、事件字段和 `escrowOf` 记录通过（1/1）。
- `escrow-postgres.integration.test.ts` 在本地 PostgreSQL 测试库 5/5 通过；其中真实验证金额不一致时写入未解决告警并冻结操作，以及退款失败保持 `retry_pending` 、超过上限后转人工处理，对应 AC-004/AC-005。
- MetaMask 真实浏览器验收使用钱包 `0x5b103f5178F35ef3196bbc12810d7E0B264C02B4`、Anvil Chain 31337 与任务 `cdc22741-00ad-470a-9969-82e9606b3baa`：首次人工取消后页面展示“可重试”与 `0/12`；重试批准后交易 `0x869e3648d3f5ae3c10d6ab7fc56e23f9ac1ecb39b7c0794f65622d5daad65089` 回执 `status=0x1`，合约事件金额为 `0.0128 ETH`，页面展示“已确认”、`13/12` 并进入 `matching`。

## 2026-08-24 确认体验优化

- 首页与托管主操作不再暴露固定区块数，只展示“链上确认后自动开始匹配”；底层状态仍保留确认进度、重组检测和人工复核。
- 本地 Anvil 与测试链默认 2 次确认，Ethereum 主网开发默认 6 次；生产缺少显式阈值时启动失败。此前 `0/12`、`13/12` 记录是改动前的真实验收证据，保留用于追溯。
