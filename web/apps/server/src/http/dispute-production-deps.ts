import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { getDaoCaseRuntime } from "../dao/dao-case-runtime";
import { getSharedPgPool, withTransaction } from "../db/pool";
import { PgDisputeRepository } from "../disputes/dispute-repository";
import { createDisputeService } from "../disputes/dispute-service";
import {
	Idempotency,
	PgIdempotencyStore,
} from "../idempotency/idempotency-store";
import type { DisputeHttpDeps } from "./dispute-handlers";

export function createProductionDisputeDeps(
	resolveActorId: DisputeHttpDeps["resolveActorId"],
): DisputeHttpDeps {
	const pool = getSharedPgPool();
	return {
		resolveActorId,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		// 每个写方法使用同一个事务内 repository + idempotency；read 也可安全运行在短事务中。
		service: {
			open: async (taskId, raw, actorId, key) => {
				const runtime = getDaoCaseRuntime();
				// 开案前验证真实托管合约支持链上冻结，不能给旧不可升级 Escrow 仅加一个新版 UI。
				if (runtime !== null) {
					// 按任务固化的 Escrow 核验，而非当前全局地址；旧任务不能被错误挂到新部署的法院。
					const intent = await pool.query<{ contract_address: string }>(
						"SELECT contract_address FROM escrow_intents WHERE task_id=$1",
						[taskId],
					);
					const address = intent.rows[0]?.contract_address;
					if (address === undefined) throw new Error("ESCROW_NOT_READY");
					await runtime.chain.verifyEscrowBinding(address);
				}
				const chainCases =
					runtime === null
						? undefined
						: {
								chainId: runtime.chain.chainId,
								contractAddress: runtime.chain.contractAddress,
								foundingArbitrators: runtime.foundingArbitrators,
							};
				return withTransaction(pool, (client) =>
					createDisputeService(
						new PgDisputeRepository(client, chainCases),
						new Idempotency(new PgIdempotencyStore(client)),
					).open(taskId, raw, actorId, key),
				);
			},
			submitEvidence: (disputeId, raw, actorId, key) =>
				withTransaction(pool, (client) =>
					createDisputeService(
						new PgDisputeRepository(client),
						new Idempotency(new PgIdempotencyStore(client)),
					).submitEvidence(disputeId, raw, actorId, key),
				),
			decide: (disputeId, raw, actorId, key) =>
				withTransaction(pool, (client) =>
					createDisputeService(
						new PgDisputeRepository(client),
						new Idempotency(new PgIdempotencyStore(client)),
					).decide(disputeId, raw, actorId, key),
				),
			read: (disputeId, actorId) =>
				withTransaction(pool, (client) =>
					createDisputeService(new PgDisputeRepository(client)).read(
						disputeId,
						actorId,
					),
				),
		},
	};
}
