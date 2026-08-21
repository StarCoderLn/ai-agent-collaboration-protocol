# Agent 接入协议基础设施 — 技术设计

## 设计版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始设计 |
| 2026-08-20 | v2   | 新增模块 4「沙箱模式标记」 |
| 2026-08-21 | v3   | 新增模块 5「过期记录清理」，补上此前只有设计意图、没有任务落地的 TTL 清理机制 |

## 项目架构

- 架构类型: 多服务架构
- 涉及层: 分发引擎（Go，协议实现主体）、交易服务（Next.js + AWS Lambda，复用同一协议库处理 Webhook 回调）、PostgreSQL（幂等键与 nonce 存储）

## 功能模块设计

### 模块 1: 请求签名与认证

采用 HMAC-SHA256 签名（`签名 = HMAC(secret, method + path + timestamp + nonce + body)`），避免引入非对称密钥管理的额外复杂度，同时满足 AGENTS.md 对领域类型和最小权限的要求。

**涉及层及关键设计:**

- Go 分发引擎实现签名生成（平台→Agent）与验签中间件（Agent→平台回调）。
- 签名密钥来自 feature 2（Agent 注册）写入的加密凭证，本 feature 只消费、不负责存储。
- 请求头：`X-Protocol-Version`、`X-Timestamp`、`X-Nonce`、`X-Signature`。
- 时间窗口默认 ±5 分钟（可配置），超出窗口直接拒绝，不进入业务逻辑。

### 模块 2: 幂等键与去重存储

幂等键格式：`{operation}:{taskId}:{clientGeneratedId}`，由调用方生成，平台侧落库并作为唯一约束。

**涉及层及关键设计:**

- PostgreSQL 表 `idempotency_records`：存储 `idempotency_key`（唯一约束）、`operation_type`、`response_snapshot`、`created_at`、`expires_at`。
- 命中已存在的幂等键时，直接返回历史 `response_snapshot`，不重新执行业务逻辑。
- 过期清理策略：超过 TTL（默认 7 天）的记录由定时任务清理，避免无限增长。

### 模块 3: 错误码与重试/超时语义

**涉及层及关键设计:**

- 统一错误码枚举（Go 与 TypeScript 各自维护同构定义，通过共享 schema 文档保持一致，而非物理共享包，避免跨语言构建耦合）：
  - `AUTH_INVALID_SIGNATURE` / `AUTH_EXPIRED_TIMESTAMP` / `AUTH_REPLAYED_NONCE`
  - `PROTOCOL_VERSION_UNSUPPORTED`
  - `CONN_TIMEOUT`
  - `AGENT_INTERNAL_ERROR`
- 重试策略：`CONN_TIMEOUT` 使用指数退避（1s/2s/4s.../最多 5 次），`AGENT_INTERNAL_ERROR` 由上层业务（feature 9 派发）决定是否更换候选 Agent，本层只负责分类与上报，不做业务级重试决策（避免信息泄漏到不该感知业务规则的层）。
- 达到重试上限的请求写入死信记录（表结构在 feature 9 中定义，本 feature 只定义写入接口契约）。

### 模块 4: 沙箱模式标记 `[v2 新增]`

**涉及层及关键设计:**

- 请求头新增 `X-Call-Type: sandbox | production`，纳入签名覆盖范围（拼入 `Sign()`/`VerifySignature()` 的签名基串），防止被中间人篡改为绕过沙箱标记。
- `idempotency_records`、审计日志写入时透传该标记；下游消费方（[[12.scoring-system]] 的评分样本计算、[[15.agent-sandbox-admission]] 的沙箱调用记录）按此字段过滤，不需要各自重新判断"这是不是测试调用"。
- 默认值为 `production`：调用方不显式声明 `sandbox` 时，一律按正式任务处理，避免遗漏标记导致沙箱调用被误计入正式统计（更危险的方向），而不是反过来默认沙箱、遗漏时误伤正式任务。

### 模块 5: 过期记录清理 `[v3 新增]`

**涉及层及关键设计:**

- `CleanupExpiredIdempotencyRecords(ctx, now) (deletedCount int, err error)`：删除 `expires_at < now` 的 `idempotency_records`，按批次删除（如每批 1000 行）避免长事务锁表。
- `CleanupExpiredNonces(ctx, now, retention) (deletedCount int, err error)`：删除 `created_at < now - retention` 的 `used_nonces`，`retention` 默认 24 小时（覆盖 ±5 分钟签名时间窗口后留足缓冲，具体时长可配置，不与时间窗口本身耦合成同一个常量）。
- 两个清理函数都是纯粹的批量 DELETE，天然幂等（重复执行只会删除"当时仍然过期"的记录，不会因为重复调用产生错误或误删未过期记录），不需要额外的去重逻辑。
- 调度方式：Go 分发引擎内的定时任务（复用模块 1/2 已有的定时任务基础设施），默认每小时执行一次，执行间隔可配置；本 feature 只提供清理函数本身，具体调度器（cron/ticker）接入点由部署时决定。

## 接口契约

- 认证中间件对外暴露：`VerifySignature(req) (VerifyResult, ProtocolError)`；`Sign(req, secret, callType) SignedHeaders`（`[v2]` `callType` 默认 `production`，`[[15.agent-sandbox-admission]]` 发起沙箱调用时显式传 `sandbox`）。
- 幂等中间件对外暴露：`CheckAndReserve(key string) (existing *ResponseSnapshot, reserved bool)`；`Commit(key string, response ResponseSnapshot) error`。
- 错误响应体统一 JSON 结构：`{ "error_code": string, "message": string, "retryable": bool }`，`message` 不得包含密钥、签名原文等敏感信息。

## 数据模型

- `idempotency_records(idempotency_key PK, operation_type, call_type, response_snapshot JSONB, created_at, expires_at)`（`[v2]` 新增 `call_type` 列，默认 `production`）
- `used_nonces(nonce PK, agent_id, created_at)`，配合时间窗口 TTL 清理，防止表无限增长。

## 安全考虑

- 签名密钥读取路径与存储路径分离：本 feature 只读凭证（由 feature 2 加密写入），不实现明文导出接口。
- 错误信息统一脱敏，日志中 `X-Signature` 与请求体中的密钥字段一律打码。
- nonce 存储需要唯一约束 + 过期清理，防止无限增长成为可用性风险。

## 技术决策

| 决策 | 选项 | 理由 |
| ---- | ---- | ---- |
| 签名算法 | HMAC-SHA256（选中）vs 非对称签名（Ed25519） | HMAC 实现和密钥管理更简单，满足当前对称信任模型；非对称签名的额外好处（防止平台伪造）在 MVP 阶段收益低于其运维复杂度 |
| 幂等存储 | PostgreSQL 唯一约束（选中）vs Redis TTL | 项目数据库统一用 PostgreSQL 存业务状态和审计记录（AGENTS.md 要求单一权威位置），幂等记录需要与业务事务一致地提交，Redis 的最终一致性会引入额外的对账复杂度 |
| 沙箱标记默认值 `[v2]` | 默认 `production`，沙箱需显式声明（选中）vs 默认 `sandbox` | 遗漏标记时应该更保守——把未声明的调用当正式任务处理，而不是让沙箱调用因遗漏标记被误算进正式历史；后者的后果（污染评分/历史数据且难以事后区分）比前者（个别测试调用被计入历史）更难恢复 |
