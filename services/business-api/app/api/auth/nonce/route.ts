/**
 * `GET /api/auth/nonce` 真实路由挂载（2.agent-registration T-010）。
 *
 * 业务逻辑与依赖装配见 src/http/auth-nonce-handler.ts、
 * src/http/auth-production-deps.ts；本文件只做 Next.js App Router Route Handler
 * 接线，不包含任何业务规则（design.md 模块 5：resolveActorId/nonce 等认证逻辑
 * 集中在 src/auth，避免多处重复实现）。
 *
 * 依赖装配延迟到首次请求时才执行（而非模块顶层立即执行）：`createProductionAuthNonceDeps`
 * 读取 `DATABASE_URL`/`SIWE_EXPECTED_*` 等运行时环境变量，这些变量在 AWS Lambda 场景下
 * 只在运行时注入，构建阶段（`next build` 收集路由配置）不一定存在；顶层立即调用会导致
 * 构建失败（已用本地无环境变量的 `pnpm build` 复现并验证此修复）。
 */
import { createAuthNonceHttpHandler } from "../../../../src/http/auth-nonce-handler";
import { createProductionAuthNonceDeps } from "../../../../src/http/auth-production-deps";

let handler: ReturnType<typeof createAuthNonceHttpHandler> | undefined;

export async function GET(): Promise<Response> {
  if (!handler) {
    handler = createAuthNonceHttpHandler(createProductionAuthNonceDeps());
  }
  return handler();
}
