import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import { createProductionResolveActorId } from "@server/http/auth-production-deps";
import { handleCorsPreflight } from "@server/http/cors";
import { createDaoHandlers } from "@server/http/dao-handlers";
import { createProductionDaoDeps } from "@server/http/dao-production-deps";

let handlers: ReturnType<typeof createDaoHandlers> | undefined;

/**
 * 延迟创建并复用 Handler，既避开模块加载阶段的运行时配置读取，也避免每个同步请求
 * 重复创建数据库连接池与链 RPC 客户端。
 */
function getHandlers() {
	return (handlers ??= createDaoHandlers(
		createProductionDaoDeps(createProductionResolveActorId()),
	));
}

export function POST(request: Request): Promise<Response> {
	return getHandlers().sync(request);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"POST, OPTIONS",
	);
}
