/**
 * `POST /api/auth/verify` 真实路由挂载（2.agent-registration T-010）。
 *
 * 业务逻辑与依赖装配见 src/http/auth-verify-handler.ts、
 * src/http/auth-production-deps.ts；本文件只做 Hono 路由模块
 * 接线，不包含任何业务规则。
 *
 * 依赖装配延迟到首次请求时才执行，理由同 `../nonce/route.ts` 顶部注释
 * （运行时环境变量在构建阶段不一定存在）。
 */

import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionAuthVerifyDeps } from "@server/http/auth-production-deps";
import { createAuthVerifyHttpHandler } from "@server/http/auth-verify-handler";
import { handleCorsPreflight } from "@server/http/cors";

let handler: ReturnType<typeof createAuthVerifyHttpHandler> | undefined;

export async function POST(request: Request): Promise<Response> {
	if (!handler) {
		handler = createAuthVerifyHttpHandler(createProductionAuthVerifyDeps());
	}
	return handler(request);
}

/**
 * `POST` 带 JSON 请求体属于非简单请求，浏览器跨源调用前会先发 `OPTIONS` 预检
 * （codex review T-010 P1 修复，见 `src/http/cors.ts` 顶部注释）。
 */
export async function OPTIONS(): Promise<Response> {
	const allowedOrigin = corsOriginFromSiweConfig(loadSiweConfigFromEnv());
	return handleCorsPreflight(allowedOrigin, "POST, OPTIONS");
}
