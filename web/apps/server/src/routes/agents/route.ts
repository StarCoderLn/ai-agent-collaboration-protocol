/**
 * `POST /api/agents` 真实路由挂载（2.agent-registration T-011）。
 *
 * 业务逻辑与依赖装配见 src/http/create-agent-handler.ts、
 * src/http/create-agent-production-deps.ts、src/http/auth-production-deps.ts；本文件只做
 * Hono 路由接线，不包含任何业务规则。
 *
 * 依赖装配延迟到首次请求时才执行（而非模块顶层立即执行），理由同
 * `../auth/nonce/route.ts` 顶部注释：`createProductionCreateAgentDeps`/
 * `createProductionResolveActorId` 读取 `DATABASE_URL`/`AGENT_CREDENTIALS_KMS_KEY_ID`/
 * `SIWE_EXPECTED_*` 等运行时环境变量，AWS Lambda 场景下这些变量只在运行时注入，
 * 静态构建阶段不一定存在。
 */

import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import { createAgentHttpHandler } from "@server/http/create-agent-handler";
import { createProductionCreateAgentDeps } from "@server/http/create-agent-production-deps";

let handler: ReturnType<typeof createAgentHttpHandler> | undefined;

export async function POST(request: Request): Promise<Response> {
	if (!handler) {
		handler = createAgentHttpHandler({
			...createProductionCreateAgentDeps(),
			resolveActorId: createProductionResolveActorId(),
		});
	}
	return handler(request);
}

/**
 * `POST` 带 JSON 请求体属于非简单请求，浏览器跨源调用前会先发 `OPTIONS` 预检
 * （T-010 codex review P1 修复同类约束，见 `src/http/cors.ts` 顶部注释）。
 */
export async function OPTIONS(): Promise<Response> {
	const allowedOrigin = corsOriginFromSiweConfig(loadSiweConfigFromEnv());
	return handleCorsPreflight(allowedOrigin, "POST, OPTIONS");
}
