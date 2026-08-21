# Business API 工程教训

- [2.agent-registration/T-002] 偏离 design.md 已选技术栈须先做高影响决策，不得误报技术栈未定。
- [2.agent-registration/T-002] 缓存明文密钥必须用调用级副本，并按 TTL 主动清零缓存本体。
- [2.agent-registration/T-006] 嵌套字段错误需显式映射到前端字段，不得用类型断言掩盖差异。
- [2.agent-registration/T-008] 审计、业务写入与幂等提交必须核对事务边界，内存替代不能证明 SQL 原子性。
