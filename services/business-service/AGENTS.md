# Business Service 数据库教训

- [2.agent-registration/T-001] 共享表枚举 CHECK 必须覆盖 PRD 全部角色，不能按当前 feature 收窄。
- [2.agent-registration/T-001] 共享表投入使用后禁止用 down migration 删除跨 feature 审计数据。
