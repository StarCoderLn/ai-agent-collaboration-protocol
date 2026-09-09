import { corsOriginFromSiweConfig, loadSiweConfigFromEnv } from "../../../../src/auth/siwe-config";
import { handleCorsPreflight } from "../../../../src/http/cors";
import { createDaoHandlers } from "../../../../src/http/dao-handlers";
import { createProductionDaoDeps } from "../../../../src/http/dao-production-deps";

let handlers: ReturnType<typeof createDaoHandlers> | undefined;

/**
 * 启动期交接状态属于公开治理信息。该路由只返回聚合人数和阶段；个人资格、案件与成员
 * 地址继续由需要 SIWE 的 `/api/dao` 提供，不能从此入口推断具体候选人。
 */
function getHandlers() {
  return handlers ??= createDaoHandlers(createProductionDaoDeps(async () => {
    throw new Error("PUBLIC_DAO_CANDIDATE_POOL_DOES_NOT_RESOLVE_ACTOR");
  }));
}

export function GET(): Promise<Response> {
  return getHandlers().candidatePool();
}

export function OPTIONS(): Response {
  return handleCorsPreflight(corsOriginFromSiweConfig(loadSiweConfigFromEnv()), "GET, OPTIONS");
}
