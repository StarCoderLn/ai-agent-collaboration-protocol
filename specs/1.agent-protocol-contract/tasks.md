# Agent 接入协议基础设施 — 任务清单

## 任务版本

| 日期       | 版本 | 说明     |
| ---------- | ---- | -------- |
| 2026-08-20 | v1   | 初始任务 |
| 2026-08-20 | v2   | 新增 T-008（沙箱模式标记） |
| 2026-08-21 | v3   | 新增 T-009（过期记录清理），补上风险点里早就点名但从未有任务真正实现的 TTL 清理缺口 |
| 2026-09-03 | v4   | 新增并完成 T-010：抽取 TypeScript Agent SDK 并迁移现有 Agent |
| 2026-09-03 | v5   | 新增并完成 T-011：实现默认快速 HTTP JSON 协议与高级模式兼容边界 |

## 项目信息

- 项目名: ai-agent-collaboration-protocol
- 架构类型: 多服务架构
- specs 路径: specs/1.agent-protocol-contract/

## 任务列表

### 功能 1: 错误码与协议版本

- [x] T-001: 定义协议错误码枚举、`X-Protocol-Version` 版本号常量与统一 JSON 错误响应结构（Go） ~30min

### 功能 2: 签名认证

- [x] T-002: 实现请求签名生成函数 `Sign()`（平台→Agent 调用侧） ~30min
- [x] T-003: 实现验签中间件 `VerifySignature()`，含时间窗口校验与 nonce 防重放（Agent→平台回调侧） ~30min

### 功能 3: 幂等键

- [x] T-004: 编写 `idempotency_records` 与 `used_nonces` 表 migration ~15min
- [x] T-005: 实现幂等中间件 `CheckAndReserve()` / `Commit()`（Go） ~30min

### 功能 4: 沙箱模式标记 `[NEW v2]`

- [x] T-008: `[NEW]` 实现 `X-Call-Type` 标记位（签名覆盖、`idempotency_records` 增加 `call_type` 列、默认 `production`） ~30min

### 功能 5: 过期记录清理 `[NEW v3]`

- [x] T-009: `[NEW]` 实现 `CleanupExpiredIdempotencyRecords()`/`CleanupExpiredNonces()`（批量删除、幂等、可配置保留时长），接入定时任务 ~30min

### 功能 6: 提供者 TypeScript SDK `[NEW v4]`

- [x] T-010: `[NEW]` 实现 `@aicp/agent-sdk`（协议、幂等、Node HTTP、正式派发与回调、Mastra/LangGraph 适配），迁移论文和产品工作流 Agent，并把上架示例收敛为 SDK 业务函数 ~90min

### 功能 7: 默认快速 HTTP JSON `[NEW v5]`

- [x] T-011: `[NEW]` 实现 `/healthz` + 同步产物响应契约、可选 Bearer Token、SSRF/DNS rebinding 防护、结果先存后转交及历史 HMAC 兼容；普通上架流程不再要求 SDK ~90min

### 集成与测试

- [x] T-006: 编写契约测试：签名校验、幂等去重、四类错误码分类、nonce 重放拒绝、沙箱标记默认值与签名覆盖 `[CHANGED v2: 增加沙箱标记用例]` ~30min
- [x] T-007: 编写协议规格 Markdown 文档（供第三方 Agent 团队接入参考，含沙箱标记说明） ~15min

## 依赖关系

- T-002、T-003 依赖 T-001（错误码定义先行）
- T-005 依赖 T-004（表结构先行）
- T-008 依赖 T-002、T-003、T-004（复用签名与幂等表结构）
- T-009 依赖 T-004（表结构先行）
- T-010 依赖 T-006（共享签名契约测试先固定，再抽取公共实现）
- T-006 依赖 T-002、T-003、T-005、T-008
- T-007 依赖 T-006（文档基于已验证的契约编写，避免文档与实现不一致）

## 风险点

- HMAC 密钥的存储与轮换实现在 feature 2，若其接口延迟交付会阻塞 T-002/T-003 的联调（可先用测试密钥 mock）。
- ~~nonce 表清理策略若未按时执行，长期运行会影响查询性能，需要在 T-004 中一并定义 TTL 清理任务或数据库层过期策略~~ `[v3 已解决]`：T-009 实现了清理函数；实际调度器（cron/ticker）接入点由部署时决定，不在本 feature 范围内。
