# 链上事件同步与钱包交互 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 明确签名客户端对接云端 KMS/HSM，不接触明文私钥（呼应 [[5.escrow-contract-ethereum]] `OPERATOR_ROLE` 托管方案） |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 交易/业务服务（Next.js + AWS Lambda，链上事件监听与对账）、PostgreSQL、前端（wagmi/viem + MetaMask）

## 功能模块设计

### 模块 1: 链上事件监听

**涉及层及关键设计:**

- 按区块高度轮询拉取 [[5.escrow-contract-ethereum]] 的事件日志（而非纯 WebSocket 订阅），轮询方式更容易做游标持久化和断点续传，符合项目对幂等和可恢复性的要求。
- `chain_event_cursor` 表持久化最后已处理的区块高度；服务重启后从游标继续，不重新扫描全部历史。
- 每个事件按 `(tx_hash, log_index)` 唯一约束写入 `escrow_sync` 表，天然防止重复写入。

### 模块 2: 确认与状态迁移

**涉及层及关键设计:**

- 事件写入时标记 `status = pending_confirmation`；后台任务定期检查区块高度差是否达到配置的确认数，达到后调用 [[4.task-creation-and-preview]] 定义的 `TransitionTaskStatus()` 推进任务状态，并将 `escrow_sync` 记录标记 `confirmed`。
- Reorg 检测：确认前定期重新校验事件所在区块的哈希是否仍在主链上；若发现区块已被替换，将该记录标记 `orphaned`，不触发状态迁移；若已错误触发（理论上不应发生，因为迁移在确认后才执行），记录待人工核实，不自动回滚已产生的下游影响（如已生成的候选列表）。

### 模块 3: 对账

**涉及层及关键设计:**

- 定时任务遍历「待匹配」及之后状态但资金记录未终态的任务，逐一调用合约 `escrowOf(taskId)` 与链下 `escrow_sync` 比对金额与状态。
- 不一致时写入 `reconciliation_alerts` 表并通知运营（走 [[13.ops-backend-and-metrics]] 的告警通道），不自动覆盖已存在的争议记录（[[12.dispute-and-arbitration]]）。

### 模块 4: 失败恢复与退款重试

**涉及层及关键设计:**

- 交易失败（含金额不足、币种不符、超时）记录在 `escrow_sync.status = failed`，附带失败原因；前端展示状态与重试入口（重新发起 `deposit` 交易，因为失败的交易本身不可重放）。
- 退款失败时 `refund_attempts` 表记录尝试次数与最后错误，状态保持 `retry_pending`，由后台任务按退避策略重试，达到上限后转人工处理（复用 [[1.agent-protocol-contract]] 的重试/死信语义，应用到资金场景）。

### 模块 5: 前端钱包交互

**涉及层及关键设计:**

- 使用 wagmi/viem 处理 MetaMask 连接与交易发起，交易状态通过监听交易回执 + 后端确认状态双重展示（前端乐观展示「已提交」，后端确认后展示「已确认」，避免只依赖前端本地状态导致与实际链上状态不一致）。

## 接口契约

- 内部：`ProcessChainEvent(event)`（幂等，按 `(tx_hash, log_index)` 去重）。
- `GET /api/tasks/:id/escrow-status`：返回 `{ status, txHash, confirmations, requiredConfirmations, failureReason? }`。
- `POST /api/tasks/:id/escrow/retry`：仅在 `status = failed` 时允许，触发前端重新发起交易的引导。

## 数据模型

- `escrow_sync(id PK, task_id FK, tx_hash, log_index, event_type, amount, status, block_number, confirmations, created_at, updated_at)`，唯一约束 `(tx_hash, log_index)`。
- `chain_event_cursor(id PK, last_processed_block, updated_at)`。
- `reconciliation_alerts(id PK, task_id FK, discrepancy_summary JSONB, created_at, resolved_at)`。
- `refund_attempts(id PK, task_id FK, attempt_no, error_message, attempted_at)`。

## 安全考虑

- 前端从不持有或请求用户私钥，全部签名通过 MetaMask 完成。
- `[v2]` 后端服务地址（`OPERATOR_ROLE`）的私钥托管方式已确认为云端 KMS/HSM 签名（见 [[5.escrow-contract-ethereum]]），代码中只通过配置注入的签名客户端调用 KMS 签名接口，任何时候都不接触、不硬编码、不落库明文私钥。
- 对账告警和失败原因展示需脱敏，不暴露内部服务地址或私钥相关配置。

## 前端视觉规范

前端实现遵循 `docs/DESIGN.md`：钱包地址、交易哈希使用等宽字体展示（区别于正文的 Inter）。资金托管相关状态使用 teal（`tertiary`，规范中专门保留给「托管保护、已确认资金状态」的语义色），待确认用 warning（琥珀），失败用 error（红），不与 AI/匹配相关的紫色混用。交易状态展示需同时有文字标签，不能仅靠色块区分「待确认/已确认/失败」。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 事件获取方式 | 区块高度轮询（选中）vs 纯 WebSocket 订阅 | 轮询天然支持游标持久化和断点续传，WebSocket 断线后的补拉逻辑本质上还是要退化为轮询，直接选轮询减少一套实现 |
| Reorg 处理 | 确认后仍定期复核区块哈希（选中）vs 只依赖确认数不复核 | 单纯依赖确认数在极端重组场景下仍有理论风险，增加复核成本很低但能提供额外安全边际 |
