/**
 * `GET /api/agents/:id`（T-012）+ `PATCH /api/agents/:id`（T-011）真实路由挂载。
 *
 * 业务逻辑与依赖装配见 src/agents/get-agent.ts、src/http/get-agent-handler.ts、
 * src/http/get-agent-production-deps.ts（GET）以及 src/http/patch-agent-handler.ts、
 * src/http/patch-agent-production-deps.ts（PATCH）；本文件只做 Hono 路由接线，不包含
 * 任何业务规则。
 *
 * 依赖装配延迟到首次请求时才执行（而非模块顶层立即执行），理由同
 * `../../auth/nonce/route.ts` 顶部注释：生产依赖装配函数读取
 * `DATABASE_URL`/`SIWE_EXPECTED_*` 等运行时环境变量，AWS Lambda 场景下这些变量
 * 只在运行时注入，构建与路由注册阶段不一定存在。
 */

import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import { createGetAgentHttpHandler } from "@server/http/get-agent-handler";
import { createProductionGetAgentDeps } from "@server/http/get-agent-production-deps";
import { createPatchAgentHttpHandler } from "@server/http/patch-agent-handler";
import { createProductionPatchAgentDeps } from "@server/http/patch-agent-production-deps";

let getHandler: ReturnType<typeof createGetAgentHttpHandler> | undefined;
let patchHandler: ReturnType<typeof createPatchAgentHttpHandler> | undefined;

/** 迁移适配器保留异步 params 契约，使既有 handler 无需感知 Hono 的路径参数 API。 */
type AgentRouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export async function GET(
	request: Request,
	context: AgentRouteContext,
): Promise<Response> {
	if (!getHandler) {
		getHandler = createGetAgentHttpHandler(createProductionGetAgentDeps());
	}
	return getHandler(request, context);
}

export async function PATCH(
	request: Request,
	context: AgentRouteContext,
): Promise<Response> {
	if (!patchHandler) {
		patchHandler = createPatchAgentHttpHandler({
			...createProductionPatchAgentDeps(),
			resolveActorId: createProductionResolveActorId(),
		});
	}
	return patchHandler(request, context);
}

/**
 * `PATCH` 带 JSON 请求体属于非简单请求，浏览器跨源调用前会先发 `OPTIONS` 预检
 * （T-010 codex review P1 修复同类约束，见 `src/http/cors.ts` 顶部注释）。
 */
export async function OPTIONS(): Promise<Response> {
	const allowedOrigin = corsOriginFromSiweConfig(loadSiweConfigFromEnv());
	return handleCorsPreflight(allowedOrigin, "GET, PATCH, OPTIONS");
}
