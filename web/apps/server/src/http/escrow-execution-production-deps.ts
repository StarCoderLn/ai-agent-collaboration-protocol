import { getOptionalEnv, getRequiredEnv } from "../config/env";
import { getSharedPgPool } from "../db/pool";
import { EscrowExecutionWorker } from "../escrow/escrow-execution-worker";
import {
	createEncryptedKeystoreOperatorClient,
	createLocalUnlockedOperatorClient,
} from "../escrow/escrow-operator-client";
import type { EscrowExecutionHttpDeps } from "./escrow-execution-handler";

let worker: EscrowExecutionWorker | undefined;

export function createProductionEscrowExecutionDeps(): EscrowExecutionHttpDeps {
	const executionWorker = getWorker();
	return {
		internalToken: getRequiredEnv("DISPATCH_INTERNAL_TOKEN"),
		run: executionWorker.runOne.bind(executionWorker),
	};
}

function getWorker(): EscrowExecutionWorker {
	if (worker !== undefined) return worker;
	const mode = getRequiredEnv("ESCROW_OPERATOR_MODE");
	if (
		mode === "local-unlocked" &&
		getOptionalEnv("NODE_ENV", "development") === "production"
	) {
		throw new Error("生产环境禁止使用 local-unlocked escrow operator");
	}
	const chainId = positiveBigint(
		"ESCROW_CHAIN_ID",
		getRequiredEnv("ESCROW_CHAIN_ID"),
	);
	const operator =
		mode === "local-unlocked"
			? createLocalUnlockedOperatorClient(
					getRequiredEnv("ETHEREUM_RPC_URL"),
					chainId,
					getRequiredEnv("ESCROW_OPERATOR_ADDRESS"),
				)
			: mode === "encrypted-keystore"
				? createEncryptedKeystoreOperatorClient(
						getRequiredEnv("ETHEREUM_RPC_URL"),
						chainId,
						getRequiredEnv("ESCROW_OPERATOR_ADDRESS"),
						getRequiredEnv("ESCROW_OPERATOR_KEYSTORE_PATH"),
						getRequiredEnv("ESCROW_OPERATOR_KEYSTORE_PASSWORD"),
					)
				: (() => {
						throw new Error("ESCROW_OPERATOR_MODE_UNSUPPORTED");
					})();
	worker = new EscrowExecutionWorker(getSharedPgPool(), operator, {
		leaseMs: positiveInteger(
			"ESCROW_EXECUTION_LEASE_MS",
			getOptionalEnv("ESCROW_EXECUTION_LEASE_MS", "60000"),
		),
		maxAttempts: positiveInteger(
			"ESCROW_EXECUTION_MAX_ATTEMPTS",
			getOptionalEnv("ESCROW_EXECUTION_MAX_ATTEMPTS", "5"),
		),
		baseRetryMs: positiveInteger(
			"ESCROW_EXECUTION_RETRY_MS",
			getOptionalEnv("ESCROW_EXECUTION_RETRY_MS", "5000"),
		),
	});
	return worker;
}

function positiveBigint(name: string, value: string): bigint {
	if (!/^\d+$/.test(value) || BigInt(value) <= 0n)
		throw new Error(`${name} 必须是正整数`);
	return BigInt(value);
}
function positiveInteger(name: string, value: string): number {
	if (!/^\d+$/.test(value)) throw new Error(`${name} 必须是正整数`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed <= 0)
		throw new Error(`${name} 必须是安全正整数`);
	return parsed;
}
