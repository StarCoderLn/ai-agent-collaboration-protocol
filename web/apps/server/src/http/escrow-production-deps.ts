import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { getOptionalEnv, getRequiredEnv } from "../config/env";
import { getSharedPgPool } from "../db/pool";
import { createJsonRpcEscrowClient } from "../escrow/escrow-chain-client";
import { resolveEscrowRequiredConfirmations } from "../escrow/escrow-confirmation-policy";
import { PgEscrowRepository } from "../escrow/escrow-repository";
import {
	type EscrowRuntimeConfig,
	EscrowService,
} from "../escrow/escrow-service";
import type {
	InternalEscrowHttpDeps,
	PublisherEscrowHttpDeps,
} from "./escrow-handlers";

/**
 * 生产 Escrow 依赖在单一进程内只装配一次，确保准备交易、同步事件和对账始终共享
 * 同一组 chainId、Escrow 地址与 USDC 地址。三个值任一漂移都会让授权目标、存款目标
 * 或事件来源互不相容，因此全部是启动必填配置，不允许请求级覆盖。
 */
let service: EscrowService | undefined;

function getService(): EscrowService {
	if (service !== undefined) return service;
	const chainId = positiveBigint(
		"ESCROW_CHAIN_ID",
		getRequiredEnv("ESCROW_CHAIN_ID"),
	);
	const client = createJsonRpcEscrowClient({
		rpcUrl: getRequiredEnv("ETHEREUM_RPC_URL"),
		chainId,
		contractAddress: getRequiredEnv("ESCROW_CONTRACT_ADDRESS"),
		paymentTokenAddress: getRequiredEnv("ESCROW_PAYMENT_TOKEN_ADDRESS"),
	});
	const config: EscrowRuntimeConfig = {
		requiredConfirmations: resolveEscrowRequiredConfirmations({
			chainId,
			environment: getOptionalEnv("NODE_ENV", "development"),
			configuredConfirmations: getOptionalEnv(
				"ESCROW_REQUIRED_CONFIRMATIONS",
				"",
			),
		}),
		startBlock: nonNegativeBigint(
			"ESCROW_START_BLOCK",
			getOptionalEnv("ESCROW_START_BLOCK", "0"),
		),
		maxBlockSpan: positiveBigint(
			"ESCROW_MAX_BLOCK_SPAN",
			getOptionalEnv("ESCROW_MAX_BLOCK_SPAN", "500"),
		),
		leaseMs: positiveInteger(
			"ESCROW_CURSOR_LEASE_MS",
			getOptionalEnv("ESCROW_CURSOR_LEASE_MS", "60000"),
		),
		eventBatchSize: positiveInteger(
			"ESCROW_EVENT_BATCH_SIZE",
			getOptionalEnv("ESCROW_EVENT_BATCH_SIZE", "500"),
		),
		recheckBatchSize: positiveInteger(
			"ESCROW_RECHECK_BATCH_SIZE",
			getOptionalEnv("ESCROW_RECHECK_BATCH_SIZE", "100"),
		),
		reconciliationBatchSize: positiveInteger(
			"ESCROW_RECONCILIATION_BATCH_SIZE",
			getOptionalEnv("ESCROW_RECONCILIATION_BATCH_SIZE", "100"),
		),
	};
	service = new EscrowService(
		new PgEscrowRepository(getSharedPgPool()),
		client,
		config,
	);
	return service;
}

export function createProductionPublisherEscrowDeps(
	resolveActorId: PublisherEscrowHttpDeps["resolveActorId"],
): PublisherEscrowHttpDeps {
	const escrow = getService();
	return {
		resolveActorId,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		prepare: escrow.prepare.bind(escrow),
		recordSubmitted: escrow.recordSubmitted.bind(escrow),
		recordFailed: escrow.recordFailed.bind(escrow),
		status: escrow.status.bind(escrow),
		retry: escrow.retry.bind(escrow),
	};
}

export function createProductionInternalEscrowDeps(): InternalEscrowHttpDeps {
	const escrow = getService();
	return {
		internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
		run: escrow.runWorker.bind(escrow),
	};
}

function positiveBigint(name: string, value: string): bigint {
	const parsed = nonNegativeBigint(name, value);
	if (parsed === 0n) throw new Error(`${name} 必须大于 0`);
	return parsed;
}
function nonNegativeBigint(name: string, value: string): bigint {
	if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是非负整数`);
	return BigInt(value);
}
function positiveInteger(name: string, value: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是正整数`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`${name} 必须是安全正整数`);
	return parsed;
}
