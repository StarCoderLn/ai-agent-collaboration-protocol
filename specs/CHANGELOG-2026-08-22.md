# 变更日志 — 2026-08-22

## Feature 2: Agent 注册与凭证管理 (2.agent-registration)

### 新增

- `PATCH /api/agents/:id` 领域逻辑与 HTTP 适配层（Web 标准 `Request`/`Response`，`resolveActorId` 由承载服务认证中间件注入）（T-004）
- `PgAuditLogWriter`：`audit_logs` 平台级共享表的参数化落库实现，作为该表唯一权威写入方（T-003）
- `createProductionCreateAgentDeps`：`POST /api/agents` 的生产依赖装配（PostgreSQL 仓储、AWS KMS 信封加密、幂等存储、审计日志写入共享同一连接池），`resolveActorId` 仍留空待认证中间件注入（T-003）
- Agent 配置编辑页（`agent-edit-form`、`credential-replace-panel`、`agent-config-edit-view`）补充 Vitest + Testing Library 覆盖：加载/空态/错误态、字段级校验、凭证明文提交后清空（T-007）

### 关键文件

- `web/apps/server/src/audit/audit-log-writer.ts` — `audit_logs` 表 Postgres 写入实现（`AuditLogWriter` 接口的唯一落地版本）
- `web/apps/server/src/http/create-agent-production-deps.ts` — `POST /api/agents` 生产依赖装配（`resolveActorId` 未装配，见下方未完成事项）
- `web/apps/server/src/agents/patch-agent.ts` / `src/http/patch-agent-handler.ts` — 编辑接口领域逻辑与 HTTP 适配层
- `web/apps/web/src/components/agents/agent-edit-form.test.tsx`、`credential-replace-panel.test.tsx`、`agent-config-edit-view.test.tsx` — 编辑页组件测试

### 架构决策

（提取自 `AGENTS.md` 第 12 节「工作流经验沉淀区」）

- [2.agent-registration/T-006,T-008] 勾选 task 完成前须核对：未独立验证的其它 task 不可批量勾选；task 声明的依赖也须已勾选。
- [2.agent-registration/T-007] 临时脚手架（占位框架）转正后必须在同一 task 或紧邻 task 里迁移旧页面，否则同 feature 出现互不连通的多个前端 App。
- [2.agent-registration/T-007] 排任务清单时"编辑/查看页" task 必须先确认对应 GET 读取端点已有独立任务，否则页面无法端到端可用。
- [2.agent-registration/T-008] AC 要求覆盖多个操作类型（创建/编辑/替换）时测试须逐项落地，遗漏一项会掩盖该操作完全未实现该行为。
- [2.agent-registration/T-004] 勾选 task 完成时须同步更新/删除 tasks.md 内『未完成原因』等说明段落，避免同文件自相矛盾。

### 补充（本日第二次同步：T-009/T-011/T-007 确认完成，最终状态）

feature 2 的 12 项任务全部完成，`resolveActorId` 认证装配、真实路由挂载与事务收敛缺口已补齐。中途曾出现过两次误标完成（工作流在 review 未通过的情况下勾选任务），均已发现并改为实际修复根因，详见 `specs/2.agent-registration/tasks.md` 版本 v7～v10 的变更记录。

#### 新增

- `app/api/agents/route.ts`、`app/api/agents/[id]/route.ts`、`app/api/agents/[id]/credentials/route.ts`：把创建/编辑/凭证替换 handler 挂载为真实 Route Handlers，接入 `resolveActorId`（T-011）
- `src/http/replace-credentials-handler.ts` / `replace-credentials-production-deps.ts`、`create-agent-production-deps.ts`、`patch-agent-production-deps.ts`：各接口的业务写入+审计+幂等提交收敛进同一 PostgreSQL 事务（复用 `src/db/pool.ts` 的 `withTransaction`）（T-011）
- `web/apps/server/infra/`：AWS CDK 部署栈（Lambda Web Adapter + zip 打包，不用容器镜像/SAM），本地验证过打包产物可运行、`cdk synth` 产出的模板正确（T-009）
- Agent 配置编辑页迁移到端到端可用状态，接入真实 `GET`/`PATCH`/`PUT`/`PUT credentials` 路由（T-007）

#### 关键文件

- `web/apps/server/infra/README.md` — 部署方案、命令、已验证/未验证清单
- `web/apps/server/src/agents/ethereum-address.ts` — `walletAddressesMatch` 单一权威实现，修正 SIWE 登录后地址大小写归一化与已注册地址不一致导致的误拒
- `web/apps/server/src/agents/price-amount.ts` — `priceAmount` 的 PostgreSQL BIGINT 范围校验单一权威实现
- `web/apps/server/src/http/cors.ts` — `handleCorsPreflight`，含跨源自定义请求头（如 `idempotency-key`）放行
- `web/apps/server/src/agents/agent.ts` 的 `isWellFormedAgentId` — 非法 UUID 直接判 404 而非让 PostgreSQL 报 500 的单一权威守卫
- `web/apps/web/src/lib/api/agents.ts` — 三个 fetch 补 `credentials:"include"`，响应体改用 zod schema 运行时校验
- `web/apps/web/src/components/agents/agent-config-edit-view.tsx` — 请求序号丢弃过期响应，修复 agentId 切换竞态

#### 架构决策

（提取自 `AGENTS.md` 第 12 节「工作流经验沉淀区」，`specs/PLAN.md` 记录 2026-08-22 用户确认冻结提供者钱包认证方案为 SIWE，部署 IaC 工具选定为 AWS CDK）

- 资金/状态迁移类操作的写入+审计+幂等提交必须收敛进同一数据库事务，不得分散为多次独立调用后依赖补偿逻辑兜底。
- Route Handler 真实挂载与认证装配（`resolveActorId`）必须在同一 task 内完成，不得让业务逻辑长期停留在"已实现但未接入真实路由/认证"的中间状态。
- 钱包地址权限比较须先归一化大小写/校验和；跨源 cookie 会话须前端 `credentials:include` + 后端 credentialed CORS（含预检、真实自定义请求头放行）。

#### 仍未解决

- 真实 PostgreSQL 连接下的端到端联调、真实 AWS KMS 调用均未在真实环境执行，当前验证均基于内存/fake 替代（`pnpm test` 通过不等同于生产可用）。
- 真实 AWS 账号执行 `cdk deploy` 未验证，需要具备账号权限的人工执行。
- T-008 集成测试仍使用内存持久化替代和 fake KMS，真实 PostgreSQL 事务与 AWS KMS 需环境级验证。
