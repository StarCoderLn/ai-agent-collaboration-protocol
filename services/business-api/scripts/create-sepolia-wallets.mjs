import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { Wallet } from "ethers";

const roles = [
	"admin",
	"escrow_operator",
	"case_operator",
	"reward_operator",
	"reward_award_operator",
	...Array.from({ length: 8 }, (_, index) =>
		`arbiter_${String(index + 1).padStart(2, "0")}`,
	),
];
const root = resolve(process.cwd(), "../../.local/sepolia-keystores");
const manifestPath = resolve(process.cwd(), "../../.local/sepolia-wallets.json");
const keychainService = "aicp-sepolia-demo-keystores";
const keychainAccount = process.env.USER?.trim() ?? "";

if (keychainAccount === "") throw new Error("LOCAL_USER_REQUIRED");
if (await exists(manifestPath)) {
	throw new Error("SEPOLIA_WALLET_MANIFEST_ALREADY_EXISTS");
}
if (await exists(root)) throw new Error("SEPOLIA_KEYSTORE_DIRECTORY_ALREADY_EXISTS");

const temporary = `${root}.${randomUUID()}.tmp`;
const password = randomBytes(32).toString("base64url");
const entries = [];
try {
	await mkdir(temporary, { recursive: true, mode: 0o700 });
	for (const role of roles) {
		const wallet = Wallet.createRandom();
		const file = `${role}.json`;
		await writeFile(
			resolve(temporary, file),
			normalizeWeb3Keystore(await wallet.encrypt(password)),
			{ mode: 0o600 },
		);
		entries.push({ role, address: wallet.address.toLowerCase(), file });
	}
	const saved = spawnSync(
		"/usr/bin/security",
		[
			"add-generic-password",
			"-U",
			"-a",
			keychainAccount,
			"-s",
			keychainService,
			"-w",
			password,
		],
		{ encoding: "utf8" },
	);
	if (saved.status !== 0) throw new Error("KEYCHAIN_PASSWORD_SAVE_FAILED");
	await rename(temporary, root);
	await chmod(root, 0o700);
	await mkdir(dirname(manifestPath), { recursive: true });
	await writeFile(
		manifestPath,
		`${JSON.stringify(
			{
				version: 1,
				chainId: "11155111",
				keychainService,
				keychainAccount,
				wallets: entries,
			},
			null,
			2,
		)}\n`,
		{ mode: 0o600, flag: "wx" },
	);
	for (const entry of entries) console.log(`${entry.role}=${entry.address}`);
} catch (error) {
	await rm(temporary, { recursive: true, force: true });
	throw error;
}

/**
 * ethers 为兼容旧客户端输出大写 `Crypto`，而 Foundry 严格读取 Web3 Secret
 * Storage 规范中的小写 `crypto`。在钱包创建边界统一格式，避免同一份加密
 * keystore 在后台 signer 可读、部署工具不可读。这里只调整 JSON 字段名，
 * 不解密或改变任何密钥材料。
 */
function normalizeWeb3Keystore(source) {
	const keystore = JSON.parse(source);
	if (keystore.crypto !== undefined || keystore.Crypto === undefined) {
		throw new Error("SEPOLIA_KEYSTORE_CRYPTO_FIELD_INVALID");
	}
	keystore.crypto = keystore.Crypto;
	delete keystore.Crypto;
	return `${JSON.stringify(keystore)}\n`;
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return false;
		throw error;
	}
}
