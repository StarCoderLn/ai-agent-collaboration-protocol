# 链上事件同步与钱包交互 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 明确签名客户端对接云端 KMS/HSM，不接触明文私钥（呼应 [[5.escrow-contract-ethereum]] `OPERATOR_ROLE` 托管方案） |
| 2026-08-23 | v3   | 前端使用 wagmi 管理 React 钱包生命周期，viem 处理链、地址与交易类型；保留自有连接界面 |
| 2026-08-23 | v4   | 将准备、钱包广播、平台登记、本地同步拆成显式阶段；已广播交易支持同 txHash 恢复登记 |
| 2026-08-27 | v5   | 钱包资金流程改为精确 USDC 授权 + deposit；只登记 deposit txHash，拒绝任何原生 value |
| 2026-08-30 | v6   | 同步 MilestoneReleased/Finalized 与累计释放额；明确本地 operator 和生产 KMS/HSM 签名边界 |
| 2026-08-31 | v7   | 钱包扩展无响应时增加有限等待和不确定状态语义，避免托管按钮永久锁定或误报失败 |
| 2026-08-31 | v8   | intent 金额改读工作流冻结总价；托管确认后将选人与正式分配按 DAG 衔接 |
| 2026-08-31 | v9   | intent 创建与改选共享任务行锁，并明确托管卡片位于方案末尾 |
| 2026-09-01 | v10  | 本地 Anvil 交易使用链上 pending nonce，并细分授权、存入和登记进度 |
| 2026-09-01 | v11  | 增加未广播托管放弃、失败后改选与旧金额提交防重放边界 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 业务服务（Hono + AWS Lambda，链上事件监听与对账）、PostgreSQL、Next.js 前端（wagmi + viem + MetaMask）

## 功能模块设计

### 模块 1: 链上事件监听

**涉及层及关键设计:**

- 按区块高度轮询 `Deposited`、`Released`、`MilestoneReleased`、`Finalized` 与
  `Refunded`（而非纯 WebSocket 订阅），便于游标持久化和断点续传。
- `chain_event_cursor` 表持久化最后已处理的区块高度；服务重启后从游标继续，不重新扫描全部历史。
- 每个事件按 `(tx_hash, log_index)` 唯一约束写入 `escrow_sync` 表，天然防止重复写入。

### 模块 2: 确认与状态迁移

**涉及层及关键设计:**

- 事件写入时标记 `pending_confirmation`。确认后，`Deposited` 推进任务进入匹配、workflow run 进入运行，根节点开放正式分配且下游保持依赖阻塞；一次性
  `Released`/`Refunded` 推进对应终态；`MilestoneReleased` 确认节点释放账本，`Finalized`
  对新工作流使用 `WorkflowSettled` 一次确认全部 Agent 分账与余额退款；对全额争议退款
  使用 `DisputeRefunded` 核对裁决哈希和证据根。历史 `MilestoneReleased` / `Finalized`
  仍可读取以恢复旧任务，但不会由新工作流创建。每类事件都有独立幂等键，不从交易回执猜测类型。
- Reorg 检测：确认前定期重新校验事件所在区块的哈希是否仍在主链上；若发现区块已被替换，将该记录标记 `orphaned`，不触发状态迁移；若已错误触发（理论上不应发生，因为迁移在确认后才执行），记录待人工核实，不自动回滚已产生的下游影响（如已生成的候选列表）。

### 模块 3: 对账

**涉及层及关键设计:**

- 定时任务遍历「待匹配」及之后状态但资金记录未终态的任务，逐一调用合约
  `escrowOf(taskId)`，与链下原托管额、累计释放额和状态比对。
- 不一致时写入 `reconciliation_alerts` 表并通知运营（走 [[13.ops-backend-and-metrics]] 的告警通道），不自动覆盖已存在的争议记录（[[12.dispute-and-arbitration]]）。

### 模块 4: 失败恢复与退款重试

**涉及层及关键设计:**

- 交易失败（含金额不足、币种不符、超时）记录在 `escrow_sync.status = failed`，附带失败原因；前端展示状态与重试入口（重新发起 `deposit` 交易，因为失败的交易本身不可重放）。
- 单 Agent 结算、正式工作流统一分账和争议退款都先持久化签名 raw transaction，再广播；失败
  时 `escrow_execution_jobs` 保持 `retry_pending` 并复用同一 txHash，达到上限转人工。
- 发布者可显式放弃仍为 `prepared` 且没有 txHash/链事件的托管准备，服务端把这次尝试记为
  `failed`。该失败只表示 Deposit 未广播，不把已完成的 USDC Approve 误认为扣款；页面随后
  重新开放逐阶段改选。`submitted`、`pending_confirmation` 或任意已有链事件的记录不能由
  客户端降级为失败，避免把结果不确定的真实交易伪装成可重试状态。

### 模块 5: 前端钱包交互

**涉及层及关键设计:**

- 使用 wagmi 的 MetaMask injected connector 管理连接、断线恢复、账户与网络变化；使用 viem 的强类型地址、链和交易参数处理 SIWE 签名与交易发起。RainbowKit 不进入 MVP，连接界面继续遵循本项目视觉规范。
- 交易状态以钱包返回的交易哈希作为「已提交」证据，以后端轮询确认状态作为「已确认」证据；页面不会把前端本地回执当成平台业务终态。
- `escrow-deposit-flow.ts` 是前端交易编排的单一权威：准备失败和钱包未返回 txHash 才能进入普通失败重试；一旦钱包返回 txHash，先在当前标签页保存恢复记录，再向平台登记。登记失败时页面只允许补登记同一 txHash，不允许再次调用钱包；本地 Anvil 推进失败也不得把已登记交易降级为失败。
- 浏览器登记 Deposit 时同时提交准备响应中的 `amountMinor`，服务端只接受与当前 intent
  完全一致的金额。sessionStorage 恢复记录也保存该金额，因此页面刷新后的“继续登记”
  仍能证明它属于哪一版报价；Agent 已改选时，旧页面的迟到登记会被明确拒绝。
- Marketplace API 返回同一金额的 `approve(escrow, amount)` 与 `deposit(taskKey, amount)` 两笔
  已编码交易。Web 按顺序发送，授权只覆盖当前任务，不使用无限额度；平台仅登记
  deposit 的 txHash，因为 approve 成功只代表额度可用，不代表资金已经进入 Escrow。
- 两笔交易的原生 `value` 都必须为零，Web 在钱包边界再次拒绝非零 value，避免异常
  服务端响应把 ETH 夹带进业务资金流程。用户仍需持有少量测试网 ETH 支付网络 Gas。
- 所有连接、切链、签名和发送交易的钱包请求设置 60 秒前端等待上限，授权交易回执单独
  使用 180 秒上限。超时只表示页面没有收到扩展结果，使用专门的
  `WalletRequestTimeoutError` 传播，托管编排不得把它登记成确定失败或自动重发。
  对普通确定失败的服务端状态登记最多等待 5 秒，页面动作完成后的权威状态补拉最多等待
  10 秒；这些辅助请求超时不会继续锁住资金按钮。错误在资金卡片内就地展示，避免用户只在
  页面其他区域看到与当前操作脱节的提示。
- MetaMask 可能在本地链重启后保留旧实例的账户 nonce。仅 Chain 31337 的交易在发送前
  从 Anvil 读取 `pending` nonce 并显式提交，防止低 nonce 缺失后交易永久停在 queued；
  Sepolia 和主网仍由钱包管理 nonce。本地授权回执上限为 30 秒，页面分别展示准备、授权、
  存入和平台登记进度，不再把整个过程统称为等待 MetaMask。

### 模块 6: 冻结总价与执行开放 `[v8 新增]`

**涉及层及关键设计:**

- `prepareIntent()` 对任务行加锁，并联接 `quote_confirmed_at IS NOT NULL` 的 workflow run；金额只读取 `quoted_total_minor`。任务不是 `awaiting_escrow`、总价为空或非正数时直接拒绝，不回退到 `tasks.budget_max_minor`。
- 选人仓储与 `prepareIntent()` 共享“先锁 task 行、再锁 intent 行”的顺序。无 intent 时可
  直接改选；intent 存在时，只有 `failed + deposit_tx_hash IS NULL + 无 escrow_sync` 才允许
  改选，并在同一事务把新总价写回 intent。其他状态返回冲突。Deposit 登记再用准备时金额
  做一次版本等价校验，避免旧标签页在改选后复活旧报价。
- `Deposited` 确认事务只负责开放执行门禁，不重新选择候选：根节点转为 `matching`，下游节点转为 `blocked`。分发引擎读取各节点已经冻结的 `final_selection_agent_id`，创建正式 assignment 后才发生 Agent 占用和协议派发。
- 该边界保证“选择”可在托管前安全修改，而“分配”只在资金确认后发生；即使 Agent 当前报价变化，也不能覆盖用户已经确认并托管的候选快照。

## 接口契约

- 内部：`ProcessChainEvent(event)`（幂等，按 `(tx_hash, log_index)` 去重）。
- `GET /api/tasks/:id/escrow-status`：返回 `{ status, txHash, confirmations, requiredConfirmations, failureReason? }`。
- `POST /api/tasks/:id/escrow/submission`：登记成功交易使用
  `{ status:'submitted', txHash, amountMinor }`；确定未广播或用户显式放弃使用
  `{ status:'failed', failureReason }`。后者只接受无 txHash、无链事件的 `prepared` intent。
- `POST /api/tasks/:id/escrow/retry`：仅在 `status = failed` 时允许，触发前端重新发起交易的引导。

## 数据模型

- `escrow_sync(id PK, task_id FK, tx_hash, log_index, event_type, amount, status, block_number, confirmations, created_at, updated_at)`，唯一约束 `(tx_hash, log_index)`；工作流释放明细与累计账本位于 workflow settlement 表，不复制到事件表。
- `chain_event_cursor(id PK, last_processed_block, updated_at)`。
- `reconciliation_alerts(id PK, task_id FK, discrepancy_summary JSONB, created_at, resolved_at)`。
- `refund_attempts(id PK, task_id FK, attempt_no, error_message, attempted_at)`。

## 安全考虑

- 前端从不持有或请求用户私钥，全部签名通过 MetaMask 完成。
- `[v6]` `EscrowOperatorClient` 隐藏签名实现并且不接受 privateKey；本地只允许非生产
  `local-unlocked`。生产 KMS/HSM client 尚未实现，生产模式因此主动启动失败，避免静默
  降级成本地解锁账户。实现并验证该适配器是部署前置条件。
- 对账告警和失败原因展示需脱敏，不暴露内部服务地址或私钥相关配置。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：钱包地址、交易哈希使用等宽字体展示（区别于正文的 Inter）。资金托管相关状态使用 teal（`tertiary`，规范中专门保留给「托管保护、已确认资金状态」的语义色），待确认用 warning（琥珀），失败用 error（红），不与 AI/匹配相关的紫色混用。交易状态展示需同时有文字标签，不能仅靠色块区分「待确认/已确认/失败」。待托管页面必须先展示完整 Agent 方案、逐阶段选择与最终总价，再在页面最下方展示钱包托管操作，禁止要求用户在确认方案前进入资金流程。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 事件获取方式 | 区块高度轮询（选中）vs 纯 WebSocket 订阅 | 轮询天然支持游标持久化和断点续传，WebSocket 断线后的补拉逻辑本质上还是要退化为轮询，直接选轮询减少一套实现 |
| Reorg 处理 | 确认后仍定期复核区块哈希（选中）vs 只依赖确认数不复核 | 单纯依赖确认数在极端重组场景下仍有理论风险，增加复核成本很低但能提供额外安全边际 |
| MetaMask 接入层 | wagmi + viem（选中）vs 手写 EIP-1193 | wagmi 集中处理账户、网络与重连生命周期，viem 为链和交易提供强类型边界；保留自有 UI，后续增加 RainbowKit 不需要推翻连接层 |
| 广播后登记恢复 | 保存 txHash 并恢复同一交易（选中）vs 把后端登记失败标为可重新发送 | 链上广播成功后再次发送会产生额外 gas，且可能让用户误以为第一笔不存在；恢复同一 txHash 能保持链上事实与平台记录一致 |
| 失败后改选边界 | 仅无 txHash/链事件的明确失败可改选（选中）vs 所有未确认状态都可改选 | 未确认不等于未广播；后者会让旧交易和新报价并发。精确失败条件兼顾恢复体验与资金一致性 |
| 正式工作流结算时点 | 全部阶段完成后统一原子结算（选中）vs 中间阶段自动验收后逐笔付款 | 中间门禁是机器质量检查，不等于发布者资金授权；统一结算使最终验收和争议可以覆盖整条 Agent 链路，并将部分失败恢复为整笔交易重试 |
