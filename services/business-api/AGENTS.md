# Business API 工程教训

- [2.agent-registration/T-002] 偏离 design.md 已选技术栈须先做高影响决策；缓存明文密钥须用调用级副本，按 TTL 主动清零缓存本体。
- [2.agent-registration/T-006] 嵌套字段错误须显式映射到前端字段，不得用类型断言掩盖差异。
- [2.agent-registration/T-008] 审计/业务写入/幂等提交须核对事务边界(内存实现不能证明 SQL 原子性)；AC 覆盖多操作类型(创建/编辑/替换)时须逐项测试，遗漏一项会掩盖该操作完全未实现。
- [2.agent-registration/T-004] 数字字符串字段校验须对齐 DB 列类型上下界(如 BIGINT)，仅正则判整数不够；钱包地址权限比较须先归一化大小写/校验和，避免合法所有者因大小写被拒。
- [2.agent-registration/T-010] resolveActorId 须区分「凭证无效/过期」与「解析器自身故障」，后者应返回可重试 5xx 而非一律 401。
- [2.agent-registration/T-010] SIWE 校验须绑定 domain/uri/chainId，不能只验签名+nonce+地址，防跨站冒用会话。
- [2.agent-registration/T-010,T-011] 独立源业务 API 用 cookie 会话须前端 credentials:include + 后端 credentialed CORS：显式导出 OPTIONS，Allow-Headers 覆盖前端真实发送的自定义 header(如 idempotency-key)，不能只放 Content-Type。
- [2.agent-registration/T-010] `src/` 内部导入用 `.js` 扩展名时 tsc/Vitest 能正确映射到 `.ts`，但被 `app/` 下真实 Route Handler(Turbopack)引用会 `Module not found`(不做 `.js`→`.ts` 重写)；首次把 `src/` 代码挂载进 `app/api/**/route.ts` 的 task 须先 `pnpm build` 验证并去掉 `.js` 后缀，不能只跑 typecheck/test 就判定挂载完成。
- [2.agent-registration/T-010] 生产依赖装配函数(如读 `DATABASE_URL`)不得在 `route.ts` 模块顶层调用——Lambda 场景下运行时变量只在调用时注入，`next build` 阶段没有会直接构建失败；须延迟到 handler 首次调用执行(惰性单例)。
- [2.agent-registration/T-009] 任务含『AWS Lambda 部署配置』时仅设 `next.config output:standalone` 不算完成，需打包/IaC 或明确降级范围再勾选；IaC 模板/代码改动即使无 AWS 凭证也应先跑本地校验（`sam validate --lint` 或 `cdk synth`）。Function URL 的 `AuthType: NONE` 不是默认禁止项——前端需要跨源直接调用、且认证由应用层机制（如 SIWE session）兜底时可以用，但必须在代码里写明这个判断依据（见 `infra/lib/business-api-stack.ts`），不能没有说明地留白，否则无法区分"深思后的选择"和"随手漏配"。
- [2.agent-registration/T-011] 完成任务前须检查代码里给自己留的 TODO 注释(如"留给 T-011 处理")，不能只对照任务描述验收。
