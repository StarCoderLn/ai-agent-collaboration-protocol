# Migrations

`golang-migrate`（https://github.com/golang-migrate/migrate）风格的 SQL migration 文件：
`{version}_{description}.up.sql` / `{version}_{description}.down.sql`，按文件名中的序号顺序执行。
与 `services/dispatch-engine/migrations` 采用同一约定，理由同见该目录 README（PostgreSQL 是项目统一数据库，SQL 文件本身是权威可读的 schema 变更记录）。

## 与 dispatch-engine 共享同一个 PostgreSQL 实例

`services/business-service` 和 `services/dispatch-engine` 写入同一个物理 PostgreSQL 数据库（见 `specs/PLAN.md`），
但各自维护独立的 migration 版本序列（互不感知对方的表结构变更节奏，符合两个 feature/服务并行开发、
互不阻塞的排期结论）。为避免 `golang-migrate` 默认的 `schema_migrations` 版本追踪表在同一数据库内冲突，
本目录的 migration 必须通过 `x-migrations-table` 参数使用独立的追踪表名。建议把带参数的完整连接串
单独放入 `BUSINESS_MIGRATIONS_DATABASE_URL`；连接串原本没有查询参数时使用 `?`，已有查询参数时使用 `&`：

```bash
migrate -path services/business-service/migrations \
  -database "$BUSINESS_MIGRATIONS_DATABASE_URL" up
migrate -path services/business-service/migrations \
  -database "$BUSINESS_MIGRATIONS_DATABASE_URL" down 1
```

例如：`postgres://user:pass@localhost/db?sslmode=disable&x-migrations-table=business_service_schema_migrations`。

`services/dispatch-engine/migrations` 沿用默认追踪表名 `schema_migrations`（历史遗留，先建立时未预见到会有第二个
服务共享同一数据库）；如需统一改名，属于两个服务的联合变更，不在本 task 范围内单独处理。

本地未安装 `migrate` CLI 时可通过 `go run github.com/golang-migrate/migrate/v4/cmd/migrate@latest ...`
或项目后续补充的 Makefile target 执行。连接串从环境变量读取，不硬编码。

`0001` 的 down migration 会删除平台共享的 `audit_logs` 表。它只允许用于尚无共享审计数据的本地/测试环境；
其他 feature 开始写入后，生产回滚必须使用前向修复 migration，不得执行 `down 1` 清空审计历史。

## 当前 migration

- `0001_agent_registration`：创建 `agents`（含 `status`/`pause_reason`，物理定义随本表，
  语义权威归属 [[3.agent-health-lifecycle]]）、`agent_credentials`、`audit_logs`（平台级共享表）三张表
  （feature 2 T-001，权威设计见 `specs/2.agent-registration/design.md` 「数据模型」）。
- `0002_auth_nonces_and_sessions`：创建 `auth_nonces`、`auth_sessions`（均为平台级共享表）两张表，
  承载提供者钱包认证（SIWE / EIP-4361）（feature 2 T-010，权威设计见
  `specs/2.agent-registration/design.md` 「模块 5：提供者钱包认证」）。
