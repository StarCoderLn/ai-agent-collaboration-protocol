# Migrations

`golang-migrate`（https://github.com/golang-migrate/migrate）风格的 SQL migration 文件：
`{version}_{description}.up.sql` / `{version}_{description}.down.sql`，按文件名中的序号顺序执行。

选择理由：项目数据库统一用 PostgreSQL（见 `specs/PLAN.md`、feature 1 design.md 技术决策），
Go 服务尚未引入 ORM，`golang-migrate` 是 Go 生态中轻量、无 ORM 依赖、支持 up/down 回滚的
事实标准工具，SQL 文件本身也是权威可读的 schema 变更记录。后续如果需要 ORM 承担查询层，
可在应用代码侧引入，不影响本目录的 migration 文件格式。

## 运行方式

```bash
# 需要设置 DATABASE_URL（PostgreSQL 连接串），CI/生产环境从环境变量读取，不硬编码。
migrate -path services/dispatch-engine/migrations -database "$DATABASE_URL" up
migrate -path services/dispatch-engine/migrations -database "$DATABASE_URL" down 1
```

本地未安装 `migrate` CLI 时可通过 `go run github.com/golang-migrate/migrate/v4/cmd/migrate@latest ...`
或项目后续补充的 Makefile target 执行；具体依赖引入（`go.mod` 增加 `golang-migrate` 相关依赖，
或应用代码内嵌 migration runner）留给消费本目录文件的实现任务（如 T-005 幂等中间件的初始化逻辑）。

## 当前 migration

- `0001_idempotency_and_nonces`：创建 `idempotency_records`、`used_nonces` 表
  （feature 1 T-004，权威设计见 `specs/1.agent-protocol-contract/design.md` 「数据模型」）。
