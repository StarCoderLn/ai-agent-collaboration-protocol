import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createJsonRpcDaoMembershipClient } from "../src/dao/dao-chain-client";
import { DaoService } from "../src/dao/dao-service";
import { asQueryExecutor, createPgPool } from "../src/db/pool";

const repository = resolve(process.cwd(), "../..");
const environment = parseEnv(
	await readFile(resolve(repository, ".local/sepolia.env"), "utf8"),
);
const manifest = JSON.parse(
	await readFile(resolve(repository, ".local/sepolia-wallets.json"), "utf8"),
) as WalletManifest;
const arbitrators = manifest.wallets
	.filter((wallet) => /^arbiter_0[1-8]$/.test(wallet.role))
	.sort((left, right) => left.role.localeCompare(right.role));
if (arbitrators.length !== 8) throw new Error("EIGHT_ARBITRATORS_REQUIRED");

const broadcastDirectory = resolve(
	repository,
	"contracts/escrow/broadcast/StakeSepoliaArbitrator.s.sol/11155111",
);
const broadcastFiles = (await readdir(broadcastDirectory))
	.filter((file) => /^run-[0-9]+\.json$/.test(file))
	.sort();
if (broadcastFiles.length !== arbitrators.length) {
	throw new Error("ARBITRATOR_STAKE_BROADCAST_COUNT_MISMATCH");
}

const stakes = await Promise.all(
	broadcastFiles.map(async (file) => {
		const broadcast = JSON.parse(
			await readFile(resolve(broadcastDirectory, file), "utf8"),
		) as Broadcast;
		const transaction = broadcast.transactions.find(
			(entry) => entry.function === "stake(uint256)",
		);
		if (transaction === undefined) throw new Error("STAKE_TRANSACTION_MISSING");
		const receipt = broadcast.receipts.find(
			(entry) => entry.transactionHash === transaction.hash,
		);
		if (receipt?.status !== "0x1")
			throw new Error("STAKE_RECEIPT_NOT_SUCCESSFUL");
		return {
			actor: transaction.transaction.from.toLowerCase(),
			txHash: transaction.hash.toLowerCase(),
		};
	}),
);
const stakeByActor = new Map(stakes.map((stake) => [stake.actor, stake]));
if (
	stakeByActor.size !== arbitrators.length ||
	arbitrators.some((wallet) => !stakeByActor.has(wallet.address.toLowerCase()))
) {
	throw new Error("ARBITRATOR_STAKE_ACTOR_MISMATCH");
}

const pool = createPgPool();
try {
	const chain = createJsonRpcDaoMembershipClient({
		rpcUrl: environment.SEPOLIA_RPC_URL,
		chainId: BigInt(environment.ARBITRATION_DAO_CHAIN_ID),
		contractAddress: environment.ARBITRATION_DAO_CONTRACT_ADDRESS,
		ydTokenAddress: environment.ARBITRATION_DAO_YD_TOKEN_ADDRESS,
		requiredConfirmations: BigInt(
			environment.ARBITRATION_DAO_REQUIRED_CONFIRMATIONS,
		),
	});
	const service = new DaoService(pool, asQueryExecutor(pool), chain, {
		minimumStakeMinor: BigInt(environment.ARBITRATION_DAO_MINIMUM_STAKE_MINOR),
		foundingArbitrators: arbitrators.map((wallet) => wallet.address),
	});
	for (const wallet of arbitrators) {
		const stake = stakeByActor.get(wallet.address.toLowerCase());
		if (stake === undefined) throw new Error("ARBITRATOR_STAKE_NOT_FOUND");
		const result = await service.syncMembership(
			wallet.address,
			{ txHash: stake.txHash },
			new Date(),
		);
		console.log(`${wallet.role}=${JSON.stringify(result.membership)}`);
	}
} finally {
	await pool.end();
}

function parseEnv(source: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new Error("SEPOLIA_ENV_INVALID");
		result[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return result;
}

type WalletManifest = Readonly<{
	wallets: readonly Readonly<{ role: string; address: string }>[];
}>;

type Broadcast = Readonly<{
	transactions: readonly Readonly<{
		hash: string;
		function: string | null;
		transaction: Readonly<{ from: string }>;
	}>[];
	receipts: readonly Readonly<{
		transactionHash: string;
		status: string;
	}>[];
}>;
