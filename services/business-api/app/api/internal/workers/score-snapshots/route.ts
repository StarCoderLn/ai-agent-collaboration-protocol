import { createInternalScoreSnapshotHandler } from "../../../../../src/http/scoring-handlers";
import { createProductionInternalScoringDeps } from "../../../../../src/http/scoring-production-deps";

let handler: ReturnType<typeof createInternalScoreSnapshotHandler> | undefined;
export function POST(request: Request): Promise<Response> {
  handler ??= createInternalScoreSnapshotHandler(createProductionInternalScoringDeps());
  return handler(request);
}
