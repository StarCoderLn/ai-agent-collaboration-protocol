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
- `0003_agent_health_lifecycle`：健康探测记录、阈值与连续计数。
- `0004_task_creation_preview`：任务主表、分类、标签、附件、手续费和时限配置。
- `0005_escrow_sync_wallet`：链上事件镜像、游标、对账告警与退款尝试。
- `0006_task_visibility_mode`：分配与验收模式配置。
- `0007_matching_candidates`：可复现的匹配记录和排名规则版本。
- `0008_dispatch_acceptance`：任务原子占用与派发尝试。
- `0009_notification_sync`：单调任务事件和 Webhook 投递。
- `0010_execution_delivery`：版本化交付结果和返工请求。
- `0011_scoring_system`：五维评分、规则版本和 Agent 得分快照。
- `0012_dispute_arbitration`：争议证据、仲裁决定与链上执行状态。
- `0013_agent_health_probe_schedule`：健康检查的持久化调度时间与 worker 租约。
- `0014_agent_reviewer_role`：历史迁移；曾在统一平台角色表中增加 Agent 审核员角色。0037 启用自动准入后不再有人工审核入口，为兼容旧审计数据保留枚举值。
- `0015_product_workflow_categories`：PRD、产品界面设计、软件开发三类稳定工作流分类。
- `0016_native_eth_money_contract`：历史迁移；曾统一原生 ETH/wei 契约。不得删除或改写，当前新业务金额语义已由 `0024` 迁移为 USDC。
- `0017_execution_failure_state`：记录 Agent 脱敏失败回调，并把任务转入可争议、资金仍托管的失败状态。
- `0018_execution_attention_state`：记录执行中的补充信息请求与预计完成时间。
- `0019_scoring_snapshot_evidence`：固化每个评分快照实际使用的评分、任务、分配与仲裁事实 ID。
- `0020_subjective_rating_boundary`：停止接收发布者“响应速度”等系统字段，保留旧数据并允许旧列为空。
- `0021_agent_sandbox_admission`：版本化沙箱模板、三次调用轮次、技术指标与清单判定留痕。
- `0022_agent_payout_wallet`：将 Agent 所有者钱包与结算收款钱包拆分；旧数据保持原收款地址。
- `0023_expand_platform_tags`：增加开发、内容、设计与 Web3 常用推荐标签；自定义标签无需入表即可精确匹配。
- `0024_usdc_only_money_contract`：将任务、报价、费率与托管统一为 6 位精度 USDC，并拒绝静默重解释历史 ETH 金额。
- `0025_execution_retry_transition`：允许执行失败任务取消旧分配并在保留托管的前提下重新匹配。
- `0026_formal_multi_agent_workflows`：正式任务工作流、节点依赖、节点级候选/分配、
  执行/制品/验收证据与 USDC 分阶段释放账本；旧任务继续使用 NULL 节点的单 Agent 路径。
- `0027_workflow_milestone_settlement`：为工作流节点增加幂等里程碑结算意图、释放金额与最终余额退款记录。
- `0028_pre_escrow_agent_selection`：先拆分和选择 Agent、冻结准确报价，再托管并按依赖派发。
- `0029_deferred_workflow_pricing`：发布时允许价格为空；匹配阶段的预算偏好与最终冻结报价、托管金额分列存储。
- `0030_task_soft_archive`：为规划前任务增加可审计软删除；市场、详情、工作台和统计统一忽略已归档任务。
- `0031_workflow_node_failure_stage`：记录正式工作流节点的模型失败阶段，使页面可以展示真实故障位置并安全重试。
- `0032_workflow_node_feedback`：按已验收工作流节点记录发布者评分、文字反馈、优点标签与独立模型训练许可；原始反馈与未来脱敏向量/训练派生数据分离。
- `0033_atomic_workflow_settlement`：新工作流停止逐阶段付款，最终验收后固化最多 32 条 Agent 分账、清单摘要与交付证据根，并由一笔链上交易原子执行。
- `0034_dao_arbitration`：增加 YD 成员镜像、DAO 仲裁轮次/小组/投票，以及带裁决摘要的专用争议退款和平台/DAO 共用的多 Agent 资金 outbox。
- `0035_optional_agent_email`：联系邮箱改为历史兼容的可空字段；新 Agent 不再因缺少邮箱而无法上架，已有非空数据保持不变。
- `0036_quick_agent_integration`：新增默认快速 HTTP JSON 接入模式和可恢复的同步结果暂存；历史 Agent 继续使用 AICP HMAC，不改变既有认证与回调语义。
- `0037_automatic_agent_admission`：新增可恢复自动准入轮次、三道标准测试题和 AI 评测字段；技术门禁通过后由固定阈值自动上架，失败支持提供者幂等重试。
- `0040_admission_cost_limits`：增加跨重启保留的准入 Worker 恢复次数，新增请求小型示例的 v3 通用模板。提供者限流复用轮次时间戳；回滚保留列、模板与历史证据，再升级可幂等执行。必须先迁移至 40，再重启分发服务。
