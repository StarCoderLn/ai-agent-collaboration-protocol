import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const phases = {
	base: "script/DeploySepoliaBase.s.sol:DeploySepoliaBase",
	"vrf-create":
		"script/CreateSepoliaVrfSubscription.s.sol:CreateSepoliaVrfSubscription",
	"vrf-fund":
		"script/FundSepoliaVrfSubscription.s.sol:FundSepoliaVrfSubscription",
	cases: "script/DeployArbitrationCases.s.sol:DeployArbitrationCases",
	"vrf-consumer": "script/AddSepoliaVrfConsumer.s.sol:AddSepoliaVrfConsumer",
	configure: "script/ConfigureSepoliaCases.s.sol:ConfigureSepoliaCases",
	bootstrap: "script/BootstrapSepoliaActors.s.sol:BootstrapSepoliaActors",
};
const phase = process.argv[2];
if (!(phase in phases)) throw new Error("SEPOLIA_ADMIN_PHASE_INVALID");

const repository = resolve(process.cwd(), "../..");
const environment = parseEnv(
	await readFile(resolve(repository, ".local/sepolia.env"), "utf8"),
);
const manifest = JSON.parse(
	await readFile(resolve(repository, ".local/sepolia-wallets.json"), "utf8"),
);
const admin = manifest.wallets.find((wallet) => wallet.role === "admin");
if (admin === undefined || admin.address !== environment.DAO_CASE_ADMIN)
	throw new Error("SEPOLIA_ADMIN_MANIFEST_MISMATCH");
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
if (password.status !== 0 || password.stdout.trim() === "")
	throw new Error("SEPOLIA_KEYCHAIN_PASSWORD_UNAVAILABLE");

const result = spawnSync(
	"forge",
	[
		"script",
		phases[phase],
		"--rpc-url",
		environment.SEPOLIA_RPC_URL,
		"--keystore",
		resolve(repository, ".local/sepolia-keystores", admin.file),
		"--password",
		password.stdout.trim(),
		"--broadcast",
		"--slow",
	],
	{
		cwd: resolve(repository, "contracts/escrow"),
		env: { ...process.env, ...environment },
		stdio: "inherit",
	},
);
if (result.status !== 0) throw new Error(`SEPOLIA_${phase.toUpperCase()}_FAILED`);

function parseEnv(source) {
	const result = {};
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new Error("SEPOLIA_ENV_INVALID");
		const key = line.slice(0, separator);
		const value = line.slice(separator + 1);
		if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("SEPOLIA_ENV_KEY_INVALID");
		result[key] = value;
	}
	return result;
}
