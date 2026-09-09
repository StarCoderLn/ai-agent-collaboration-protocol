import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { asQueryExecutor, getSharedPgPool, withTransaction } from "../db/pool";
import {
	readDisputeEvidenceObject,
	storeDisputeEvidenceObject,
} from "../disputes/dispute-evidence-object";
import type { DisputeEvidenceObjectHttpDeps } from "./dispute-evidence-object-handlers";

export function createProductionDisputeEvidenceObjectDeps(
	resolveActorId: DisputeEvidenceObjectHttpDeps["resolveActorId"],
): DisputeEvidenceObjectHttpDeps {
	const pool = getSharedPgPool();
	return {
		resolveActorId,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		store: (input) =>
			withTransaction(pool, (client) =>
				storeDisputeEvidenceObject(client, { ...input, now: new Date() }),
			),
		read: (disputeId, objectId, actorId) =>
			readDisputeEvidenceObject(
				asQueryExecutor(pool),
				disputeId,
				objectId,
				actorId,
			),
	};
}
