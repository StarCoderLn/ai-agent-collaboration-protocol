import { createInternalScoreSnapshotHandler } from "@server/http/scoring-handlers";
import { createProductionInternalScoringDeps } from "@server/http/scoring-production-deps";

let handler: ReturnType<typeof createInternalScoreSnapshotHandler> | undefined;
export function POST(request: Request): Promise<Response> {
	handler ??= createInternalScoreSnapshotHandler(
		createProductionInternalScoringDeps(),
	);
	return handler(request);
}
