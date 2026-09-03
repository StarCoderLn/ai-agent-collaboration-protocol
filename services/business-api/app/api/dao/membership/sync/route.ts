import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../../../src/http/cors";
import { createDaoHandlers } from "../../../../../src/http/dao-handlers";
import { createProductionDaoDeps } from "../../../../../src/http/dao-production-deps";

let handlers: ReturnType<typeof createDaoHandlers> | undefined;

/**
 * 延迟创建并复用 Handler，既避开 Next.js 构建阶段的运行时配置读取，也避免每个同步请求
 * 重复创建数据库连接池与链 RPC 客户端。
 */
function getHandlers() {
  return handlers ??= createDaoHandlers(createProductionDaoDeps(createProductionResolveActorId()));
}

export function POST(request: Request): Promise<Response> {
  return getHandlers().sync(request);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS");
}
