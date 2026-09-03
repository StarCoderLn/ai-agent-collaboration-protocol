import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../src/http/cors";
import { createDaoHandlers } from "../../../src/http/dao-handlers";
import { createProductionDaoDeps } from "../../../src/http/dao-production-deps";

let handlers: ReturnType<typeof createDaoHandlers> | undefined;

/**
 * 生产依赖必须在首个请求到达时再创建，不能在模块加载阶段读取环境变量或连接数据库；
 * Next.js 构建路由时也会加载本文件，提前装配会让缺少运行时密钥的构建直接失败。
 */
function getHandlers() {
  return handlers ??= createDaoHandlers(createProductionDaoDeps(createProductionResolveActorId()));
}

export function GET(request: Request): Promise<Response> {
  return getHandlers().overview(request);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
