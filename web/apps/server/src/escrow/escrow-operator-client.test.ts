import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	encryptKeystoreJsonSync,
	FeeData,
	JsonRpcProvider,
	Network,
	Transaction,
	Wallet,
} from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EncryptedKeystoreEscrowOperatorClient } from "./escrow-operator-client";

const directories: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("加密 keystore operator", () => {
	it("解锁匹配钱包并签署固定链、pending nonce 和目标调用", async () => {
		const wallet = new Wallet(`0x${"11".repeat(32)}`);
		const path = await keystore(wallet, "test-password");
		const provider = new JsonRpcProvider("http://127.0.0.1:1", 11_155_111, {
			staticNetwork: true,
		});
		vi.spyOn(provider, "getNetwork").mockResolvedValue(
			Network.from(11_155_111),
		);
		vi.spyOn(provider, "getTransactionCount").mockResolvedValue(7);
		vi.spyOn(provider, "estimateGas").mockResolvedValue(50_000n);
		vi.spyOn(provider, "getFeeData").mockResolvedValue(
			new FeeData(null, 20n, 2n),
		);
		const operator = new EncryptedKeystoreEscrowOperatorClient(
			provider,
			wallet.address,
			path,
			"test-password",
		);

		const prepared = await operator.prepareContractCall(
			`0x${"22".repeat(20)}`,
			"0x12345678",
		);
		const transaction = Transaction.from(prepared.rawTransaction);
		expect(transaction.from).toBe(wallet.address);
		expect(transaction.chainId).toBe(11_155_111n);
		expect(transaction.nonce).toBe(7);
		expect(transaction.gasLimit).toBe(50_000n);
		expect(transaction.data).toBe("0x12345678");
		expect(transaction.hash).toBe(prepared.txHash);
		expect(provider.getTransactionCount).toHaveBeenCalledWith(
			wallet.address,
			"pending",
		);
	});

	it("配置地址与加密文件不一致时拒绝签名", async () => {
		const wallet = new Wallet(`0x${"33".repeat(32)}`);
		const operator = new EncryptedKeystoreEscrowOperatorClient(
			new JsonRpcProvider("http://127.0.0.1:1"),
			`0x${"44".repeat(20)}`,
			await keystore(wallet, "test-password"),
			"test-password",
		);
		await expect(
			operator.prepareContractCall(`0x${"55".repeat(20)}`, "0x"),
		).rejects.toThrow("OPERATOR_KEYSTORE_ADDRESS_MISMATCH");
	});
});

async function keystore(wallet: Wallet, password: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "aicp-keystore-"));
	directories.push(directory);
	const path = join(directory, "operator.json");
	const encrypted = encryptKeystoreJsonSync(
		{ address: wallet.address, privateKey: wallet.privateKey },
		password,
		{ scrypt: { N: 1024, r: 8, p: 1 } },
	);
	await writeFile(path, encrypted, { mode: 0o600 });
	return path;
}
