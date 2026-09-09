import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const action = process.argv[2];
const role = process.argv[3];
if (
	!/^(stake|vote)$/.test(action ?? "") ||
	!/^arbiter_0[1-8]$/.test(role ?? "")
) {
	throw new Error("SEPOLIA_ACTOR_ACTION_INVALID");
}

const caseKey = process.argv[4];
const releaseBps = process.argv[5];
const reasoningHash = process.argv[6];
if (
	action === "vote" &&
	(!/^0x[0-9a-fA-F]{64}$/.test(caseKey ?? "") ||
		!/^\d{1,5}$/.test(releaseBps ?? "") ||
		Number(releaseBps) > 10_000 ||
		!/^0x(?!0{64}$)[0-9a-fA-F]{64}$/.test(reasoningHash ?? ""))
) {
	throw new Error("SEPOLIA_ACTOR_VOTE_INVALID");
}

const repository = resolve(process.cwd(), "../..");
const environment = parseEnv(
	await readFile(resolve(repository, ".local/sepolia.env"), "utf8"),
);
const manifest = JSON.parse(
	await readFile(resolve(repository, ".local/sepolia-wallets.json"), "utf8"),
);
const actor = manifest.wallets.find((wallet) => wallet.role === role);
if (actor === undefined) throw new Error("SEPOLIA_ACTOR_NOT_FOUND");

const password = spawnSync(
	"/usr/bin/security",
	[
		"find-generic-password",
		"-w",
		"-a",
		manifest.keychainAccount,
		"-s",
		manifest.keychainService,
	],
	{ encoding: "utf8" },
);
if (password.status !== 0 || password.stdout.trim() === "") {
	throw new Error("SEPOLIA_KEYCHAIN_PASSWORD_UNAVAILABLE");
}

const actorKeystore = resolve(
	repository,
	".local/sepolia-keystores",
	actor.file,
);
const command =
	action === "stake"
		? {
				executable: "forge",
				args: [
					"script",
					"script/StakeSepoliaArbitrator.s.sol:StakeSepoliaArbitrator",
					"--rpc-url",
					environment.SEPOLIA_RPC_URL,
					"--keystore",
					actorKeystore,
					"--password",
					password.stdout.trim(),
					"--broadcast",
					"--slow",
				],
			}
		: {
				executable: "cast",
				args: [
					"send",
					environment.ARBITRATION_CASES_CONTRACT_ADDRESS,
					"vote(bytes32,uint16,bytes32)",
					caseKey,
					releaseBps,
					reasoningHash,
					"--rpc-url",
					environment.SEPOLIA_RPC_URL,
					"--keystore",
					actorKeystore,
					"--password",
					password.stdout.trim(),
					"--confirmations",
					environment.ARBITRATION_CASES_REQUIRED_CONFIRMATIONS,
				],
			};

const result = spawnSync(command.executable, command.args, {
	cwd: resolve(repository, "contracts/escrow"),
	env: { ...process.env, ...environment, SEPOLIA_ACTOR_ADDRESS: actor.address },
	stdio: "inherit",
});
if (result.status !== 0)
	throw new Error(
		`SEPOLIA_${role.toUpperCase()}_${action.toUpperCase()}_FAILED`,
	);

function parseEnv(source) {
	const result = {};
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new Error("SEPOLIA_ENV_INVALID");
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
			throw new Error("SEPOLIA_ENV_KEY_INVALID");
		}
		result[key] = value;
	}
	return result;
}
