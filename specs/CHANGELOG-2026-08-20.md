# 变更日志 — 2026-08-20

## Feature 1: Agent 接入协议基础设施 (1.agent-protocol-contract)

### 新增

- 协议错误码枚举、`X-Protocol-Version` 版本号常量与统一 JSON 错误响应结构（T-001）
- 请求签名生成函数 `Sign()`（平台→Agent 调用侧，HMAC-SHA256）（T-002）
- 验签中间件 `VerifySignature()`，含时间窗口校验与 nonce 防重放（Agent→平台回调侧）（T-003）
- `idempotency_records` 与 `used_nonces` 表 migration（T-004）
- 幂等中间件 `CheckAndReserve()` / `Commit()`（T-005）
- `X-Call-Type` 沙箱模式标记位：签名覆盖防篡改、`idempotency_records` 新增 `call_type` 列、默认值 `production`（T-008，v2 新增需求 F-006）
- 契约测试覆盖 AC-001~AC-006：签名校验、幂等去重、四类错误码分类、nonce 重放拒绝、沙箱标记默认值与签名覆盖（T-006）
- 协议规格文档 `docs/agent-protocol.md`，供第三方 Agent 团队独立接入参考（T-007）

### 关键文件

- `services/dispatch-engine/go.mod` — 新建 Go module（`services/dispatch-engine`）
- `services/dispatch-engine/internal/protocol/version.go` — 协议版本常量
- `services/dispatch-engine/internal/protocol/errors.go` — 统一错误码与 JSON 错误响应结构
- `services/dispatch-engine/internal/protocol/sign.go` — 请求签名生成
- `services/dispatch-engine/internal/protocol/verify.go` — 验签中间件（时间窗口 + nonce 防重放）
- `services/dispatch-engine/internal/protocol/idempotency.go` — 幂等键中间件
- `services/dispatch-engine/internal/protocol/contract_test.go` — AC-001~AC-006 契约测试
- `services/dispatch-engine/migrations/0001_idempotency_and_nonces.up.sql` / `.down.sql` — 幂等/nonce 表结构
- `docs/agent-protocol.md` — 面向第三方团队的协议规格文档

### 架构决策

（提取自 `AGENTS.md` 第 12 节「工作流经验沉淀区」）

- [1.agent-protocol-contract/T-001] Go module path 须对齐实际 git remote（`services/<name>`），否则跨服务 import 解析失败。
- [1.agent-protocol-contract/T-002] 已记录的历史教训需在下个 task 验证是否真落地，不能只记不查。
- [1.agent-protocol-contract/T-005,T-008] 给已有字段加标记位/新增列，仅改签名或建列不够，须同步扩展 store 写入接口参数回填，否则被 DB 默认值掩盖、字段无法落库。
- [1.agent-protocol-contract/T-006] 契约测试若只断言错误码/默认值等静态属性、未经真实入口驱动触发，会掩盖该行为实际不可达。
- 签名基串固定为 `method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + call_type + "\n" + body`，`call_type` 纳入签名防止中间人篡改 sandbox/production 标记（见 `docs/agent-protocol.md` §2.2）。
- `X-Call-Type` 默认值选定为 `production` 而非 `sandbox`：遗漏标记的调用被当作正式任务处理，比误算进正式历史更安全、更易恢复（见 `docs/agent-protocol.md` §3）。
- 入站请求固定校验顺序：协议版本 → 时间窗口 → 必填字段 → 签名 → nonce 占用，确保未认证请求无法抢占合法 nonce（见 `docs/agent-protocol.md` §2.6）。
