# Marketplace API 工程教训

- [2.agent-registration/T-002] 偏离 design.md 已选技术栈须先做高影响决策；缓存明文密钥须用调用级副本，按 TTL 主动清零缓存本体。
- [2.agent-registration/T-006] 嵌套字段错误须显式映射到前端字段，不得用类型断言掩盖差异。
- [2.agent-registration/T-008] 审计/业务写入/幂等提交须核对事务边界(内存实现不能证明 SQL 原子性)；AC 覆盖多操作类型(创建/编辑/替换)时须逐项测试，遗漏一项会掩盖该操作完全未实现。
- [2.agent-registration/T-004] 数字字符串字段校验须对齐 DB 列类型上下界(如 BIGINT)，仅正则判整数不够；钱包地址权限比较须先归一化大小写/校验和，避免合法所有者因大小写被拒。
- [2.agent-registration/T-010] resolveActorId 须区分「凭证无效/过期」与「解析器自身故障」，后者应返回可重试 5xx 而非一律 401。
- [2.agent-registration/T-010] SIWE 校验须绑定 domain/uri/chainId，不能只验签名+nonce+地址，防跨站冒用会话。
- [2.agent-registration/T-010,T-011] 独立源业务 API 用 cookie 会话须前端 credentials:include + 后端 credentialed CORS：显式导出 OPTIONS，Allow-Headers 覆盖前端真实发送的自定义 header(如 idempotency-key)，不能只放 Content-Type。
- [hono-migration] 生产依赖装配函数不得在路由模块顶层调用；Hono 本机与 Lambda 入口复用同一 app，依赖仍按请求惰性创建。
- [hono-migration] `src/routes/**/route.ts` 继续导出标准 Request/Response handler；路径转换和异步 params 只由 `hono-route-adapter.ts` 维护。
- [2.agent-registration/T-009] Lambda 变更须验证 Hono bundle、`cdk synth` 和本机 `/api/health`；Function URL 的应用层 SIWE/CORS 边界须在 IaC 中说明。
- [2.agent-registration/T-011] 完成任务前须检查代码里给自己留的 TODO 注释(如"留给 T-011 处理")，不能只对照任务描述验收。
