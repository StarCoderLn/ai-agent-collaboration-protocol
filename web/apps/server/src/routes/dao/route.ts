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
 * 生产依赖必须在首个请求到达时再创建，不能在模块加载阶段读取环境变量或连接数据库；
 * Hono 注册路由时会加载本文件，提前装配会让缺少运行时密钥的构建直接失败。
 */
function getHandlers() {
	return (handlers ??= createDaoHandlers(
		createProductionDaoDeps(createProductionResolveActorId()),
	));
}

export function GET(request: Request): Promise<Response> {
	return getHandlers().overview(request);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
