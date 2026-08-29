/**
 * `PUT /api/agents/:id/credentials` 真实路由挂载（2.agent-registration T-011）。
 *
 * 业务逻辑与依赖装配见 src/http/replace-credentials-handler.ts、
 * src/http/replace-credentials-production-deps.ts、src/http/auth-production-deps.ts；
 * 本文件只做 Next.js App Router Route Handler 接线，不包含任何业务规则。
 *
 * 依赖装配延迟到首次请求时才执行（而非模块顶层立即执行），理由同
 * `../../../auth/nonce/route.ts` 顶部注释：生产依赖装配函数读取
 * `DATABASE_URL`/`AGENT_CREDENTIALS_KMS_KEY_ID`/`SIWE_EXPECTED_*` 等运行时环境变量，
 * AWS Lambda 场景下这些变量只在运行时注入，`next build` 收集路由配置阶段不一定存在。
 */
import {
  createReplaceCredentialsHttpHandler,
} from "../../../../../src/http/replace-credentials-handler";
import { createProductionReplaceCredentialsDeps } from "../../../../../src/http/replace-credentials-production-deps";
import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../../src/http/cors";

let handler: ReturnType<typeof createReplaceCredentialsHttpHandler> | undefined;

/** 框架导出使用 Next.js 16 的严格形状；内部 handler 仍接受同步对象以便独立测试。 */
type NextCredentialsRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export async function PUT(request: Request, context: NextCredentialsRouteContext): Promise<Response> {
  if (!handler) {
    handler = createReplaceCredentialsHttpHandler({
      ...createProductionReplaceCredentialsDeps(),
      resolveActorId: createProductionResolveActorId(),
    });
  }
  return handler(request, context);
}

/**
 * `PUT` 带 JSON 请求体属于非简单请求，浏览器跨源调用前会先发 `OPTIONS` 预检
 * （T-010 codex review P1 修复同类约束，见 `src/http/cors.ts` 顶部注释）。
 */
export async function OPTIONS(): Promise<Response> {
  const allowedOrigin = corsOriginFromSiweConfig(loadSiweConfigFromEnv());
  return handleCorsPreflight(allowedOrigin, "PUT, OPTIONS");
}
