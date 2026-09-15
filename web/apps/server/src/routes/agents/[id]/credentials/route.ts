/**
 * `PUT /api/agents/:id/credentials` 真实路由挂载（2.agent-registration T-011）。
 *
 * 业务逻辑与依赖装配见 src/http/replace-credentials-handler.ts、
 * src/http/replace-credentials-production-deps.ts、src/http/auth-production-deps.ts；
 * 本文件只做 Hono 路由接线，不包含任何业务规则。
 *
 * 依赖装配延迟到首次请求时才执行（而非模块顶层立即执行），理由同
 * `../../../auth/nonce/route.ts` 顶部注释：生产依赖装配函数读取
 * `DATABASE_URL`/`AGENT_CREDENTIALS_KMS_KEY_ID`/`SIWE_EXPECTED_*` 等运行时环境变量，
 * AWS Lambda 场景下这些变量只在运行时注入，构建与路由注册阶段不一定存在。
 */

import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import { createReplaceCredentialsHttpHandler } from "@server/http/replace-credentials-handler";
import { createProductionReplaceCredentialsDeps } from "@server/http/replace-credentials-production-deps";

let handler: ReturnType<typeof createReplaceCredentialsHttpHandler> | undefined;

/** 迁移适配器保留异步 params 契约，使既有 handler 无需感知 Hono 的路径参数 API。 */
type CredentialsRouteContext = Readonly<{
	params: Promise<{ id: string }>;
}>;

export async function PUT(
	request: Request,
	context: CredentialsRouteContext,
): Promise<Response> {
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
