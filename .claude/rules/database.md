---
description: PostgreSQL migration 与数据模型规范（services/dispatch-engine、services/business-service 共享同一实例）
globs: services/dispatch-engine/migrations/**,services/business-service/migrations/**
---

# 数据库规则

`services/dispatch-engine` 与 `services/business-service` 共享同一个物理 PostgreSQL 实例（见 `specs/PLAN.md`），
但各自维护独立的 `golang-migrate` 版本序列和独立的追踪表，互不感知对方的 schema 变更节奏。

## Migration 约定

1. 统一使用 `golang-migrate` 风格文件名：`{version}_{description}.up.sql` / `{version}_{description}.down.sql`，按文件名序号顺序执行。
2. `services/business-service` 必须通过 `-database` 连接串的 `x-migrations-table` 参数使用独立追踪表
   `business_service_schema_migrations`，避免与 `services/dispatch-engine` 默认的 `schema_migrations` 表冲突；
   完整命令与连接串示例见 `services/business-service/migrations/README.md`。
3. `services/dispatch-engine/migrations` 沿用默认追踪表名 `schema_migrations`（历史遗留）；如需统一改名，
   属于两个服务的联合变更，需先出具高影响决策摘要，不得在单个 task 内单方面处理。
4. 迁移文件一旦合并到 `main` 且可能已在共享环境执行，不得修改其内容；需要变更须新增一个后续 migration。
5. 破坏性 `down` migration（如删除平台级共享表 `audit_logs`）只允许用于尚无共享数据的本地/测试环境；
   生产环境回滚一律使用前向修复 migration，不得执行会清空共享数据的 `down`。
6. 本地未安装 `migrate` CLI 时使用 `go run github.com/golang-migrate/migrate/v4/cmd/migrate@latest ...`；
   连接串一律从环境变量读取（如 `BUSINESS_MIGRATIONS_DATABASE_URL`），不得硬编码或提交到仓库。

## 数据模型与 schema 设计

7. 每张表的字段语义权威归属唯一 feature 的 `design.md`（如 `agents.status`/`pause_reason` 的语义权威见
   `specs/3.agent-health-lifecycle`），物理定义可以随迁移它的表所在目录，但不得在多处重复定义同一业务规则。
8. 平台级共享表（如 `audit_logs`）的表结构变更需评估所有写入方，不得只按单个 feature 视角修改。
9. 修改数据库 schema（新增/修改/删除表、字段、索引、约束）属于 AGENTS.md 定义的高影响任务，
   实施前必须输出高影响决策摘要，并说明是否需要数据回填。

## 查询与访问

10. 所有查询必须参数化（`database/sql` 的 `$1`/`?` 占位符或等价 ORM 参数绑定），禁止使用字符串拼接构造 SQL。
11. 金额、余额等字段禁止使用浮点类型，使用定点/整数最小单位表示。

## 验证

12. 涉及 migration 的改动需在本地执行 `up`/`down` 验证可逆性；无法连接真实 PostgreSQL 时，
    需在任务说明中明确列出未验证项，不得假设 migration 已在真实环境跑通。
