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

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（Next.js + AWS Lambda，链上事件监听与对账）、PostgreSQL、前端（wagmi + viem + MetaMask）

## 功能模块设计

### 模块 1: 链上事件监听

**涉及层及关键设计:**

- 按区块高度轮询 `Deposited`、`Released`、`MilestoneReleased`、`Finalized` 与
  `Refunded`（而非纯 WebSocket 订阅），便于游标持久化和断点续传。
- `chain_event_cursor` 表持久化最后已处理的区块高度；服务重启后从游标继续，不重新扫描全部历史。
- 每个事件按 `(tx_hash, log_index)` 唯一约束写入 `escrow_sync` 表，天然防止重复写入。

### 模块 2: 确认与状态迁移

**涉及层及关键设计:**

- 事件写入时标记 `pending_confirmation`。确认后，`Deposited` 推进任务进入匹配；一次性
  `Released`/`Refunded` 推进对应终态；`MilestoneReleased` 确认节点释放账本，`Finalized`
  在全部里程碑完成后确认任务结算终态。每类事件都有独立幂等键，不从交易回执猜测类型。
- Reorg 检测：确认前定期重新校验事件所在区块的哈希是否仍在主链上；若发现区块已被替换，将该记录标记 `orphaned`，不触发状态迁移；若已错误触发（理论上不应发生，因为迁移在确认后才执行），记录待人工核实，不自动回滚已产生的下游影响（如已生成的候选列表）。

### 模块 3: 对账

**涉及层及关键设计:**

- 定时任务遍历「待匹配」及之后状态但资金记录未终态的任务，逐一调用合约
  `escrowOf(taskId)`，与链下原托管额、累计释放额和状态比对。
- 不一致时写入 `reconciliation_alerts` 表并通知运营（走 [[13.ops-backend-and-metrics]] 的告警通道），不自动覆盖已存在的争议记录（[[12.dispute-and-arbitration]]）。

### 模块 4: 失败恢复与退款重试

**涉及层及关键设计:**

- 交易失败（含金额不足、币种不符、超时）记录在 `escrow_sync.status = failed`，附带失败原因；前端展示状态与重试入口（重新发起 `deposit` 交易，因为失败的交易本身不可重放）。
- 一次性结算、里程碑释放、最终关闭和退款都先持久化签名 raw transaction，再广播；失败
  时 `escrow_execution_jobs` 保持 `retry_pending` 并复用同一 txHash，达到上限转人工。

### 模块 5: 前端钱包交互

**涉及层及关键设计:**

- 使用 wagmi 的 MetaMask injected connector 管理连接、断线恢复、账户与网络变化；使用 viem 的强类型地址、链和交易参数处理 SIWE 签名与交易发起。RainbowKit 不进入 MVP，连接界面继续遵循本项目视觉规范。
- 交易状态以钱包返回的交易哈希作为「已提交」证据，以后端轮询确认状态作为「已确认」证据；页面不会把前端本地回执当成平台业务终态。
- `escrow-deposit-flow.ts` 是前端交易编排的单一权威：准备失败和钱包未返回 txHash 才能进入普通失败重试；一旦钱包返回 txHash，先在当前标签页保存恢复记录，再向平台登记。登记失败时页面只允许补登记同一 txHash，不允许再次调用钱包；本地 Anvil 推进失败也不得把已登记交易降级为失败。
- Business API 返回同一金额的 `approve(escrow, amount)` 与 `deposit(taskKey, amount)` 两笔
  已编码交易。Web 按顺序发送，授权只覆盖当前任务，不使用无限额度；平台仅登记
  deposit 的 txHash，因为 approve 成功只代表额度可用，不代表资金已经进入 Escrow。
- 两笔交易的原生 `value` 都必须为零，Web 在钱包边界再次拒绝非零 value，避免异常
  服务端响应把 ETH 夹带进业务资金流程。用户仍需持有少量测试网 ETH 支付网络 Gas。

## 接口契约

- 内部：`ProcessChainEvent(event)`（幂等，按 `(tx_hash, log_index)` 去重）。
- `GET /api/tasks/:id/escrow-status`：返回 `{ status, txHash, confirmations, requiredConfirmations, failureReason? }`。
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

前端实现遵循 `docs/DESIGN.md`：钱包地址、交易哈希使用等宽字体展示（区别于正文的 Inter）。资金托管相关状态使用 teal（`tertiary`，规范中专门保留给「托管保护、已确认资金状态」的语义色），待确认用 warning（琥珀），失败用 error（红），不与 AI/匹配相关的紫色混用。交易状态展示需同时有文字标签，不能仅靠色块区分「待确认/已确认/失败」。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 事件获取方式 | 区块高度轮询（选中）vs 纯 WebSocket 订阅 | 轮询天然支持游标持久化和断点续传，WebSocket 断线后的补拉逻辑本质上还是要退化为轮询，直接选轮询减少一套实现 |
| Reorg 处理 | 确认后仍定期复核区块哈希（选中）vs 只依赖确认数不复核 | 单纯依赖确认数在极端重组场景下仍有理论风险，增加复核成本很低但能提供额外安全边际 |
| MetaMask 接入层 | wagmi + viem（选中）vs 手写 EIP-1193 | wagmi 集中处理账户、网络与重连生命周期，viem 为链和交易提供强类型边界；保留自有 UI，后续增加 RainbowKit 不需要推翻连接层 |
| 广播后登记恢复 | 保存 txHash 并恢复同一交易（选中）vs 把后端登记失败标为可重新发送 | 链上广播成功后再次发送会产生额外 gas，且可能让用户误以为第一笔不存在；恢复同一 txHash 能保持链上事实与平台记录一致 |
