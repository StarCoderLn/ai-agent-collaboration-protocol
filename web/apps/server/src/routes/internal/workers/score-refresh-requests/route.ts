import { createInternalScoreSnapshotHandler } from "@server/http/scoring-handlers";
import { createProductionInternalScoreRefreshDeps } from "@server/http/scoring-production-deps";

// 刷新请求已经由业务事务持久化；本路由只让受信任 Worker 领取并定向生成快照。
let handler: ReturnType<typeof createInternalScoreSnapshotHandler> | undefined;
export function POST(request: Request): Promise<Response> {
	handler ??= createInternalScoreSnapshotHandler(
		createProductionInternalScoreRefreshDeps(),
	);
	return handler(request);
}
