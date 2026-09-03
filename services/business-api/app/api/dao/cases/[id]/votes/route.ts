import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../../../../src/http/cors";
import { createDaoHandlers, type DaoRouteContext } from "../../../../../../src/http/dao-handlers";
import { createProductionDaoDeps } from "../../../../../../src/http/dao-production-deps";

let handlers: ReturnType<typeof createDaoHandlers> | undefined;

/**
 * 投票路由只负责把已认证请求交给领域 Handler。依赖采用请求期惰性初始化，确保构建阶段
 * 不读取链上密钥，并让同一进程内的幂等存储和 DAO 服务保持一致。
 */
function getHandlers() {
  return handlers ??= createDaoHandlers(createProductionDaoDeps(createProductionResolveActorId()));
}

export function POST(request: Request, context: DaoRouteContext): Promise<Response> {
  return getHandlers().vote(request, context);
}

export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "POST, OPTIONS");
}
