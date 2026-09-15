import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	connect,
	getConnection,
	getTransactionCount,
	readContract,
	reconnect,
	sendTransaction,
	signMessage,
	switchChain,
	waitForTransactionReceipt,
} from "wagmi/actions";

import { metaMaskConnector, wagmiConfig } from "./wagmi-config";
import {
	connectWalletSession,
	ensureEscrowAllowance,
	logoutWalletSession,
	restoreAuthorizedWalletConnection,
	sendEscrowTransaction,
	WalletRequestTimeoutError,
} from "./wallet-session";

vi.mock("wagmi/actions", () => ({
	connect: vi.fn(),
	getConnection: vi.fn(),
	getTransactionCount: vi.fn(),
	readContract: vi.fn(),
	reconnect: vi.fn(),
	sendTransaction: vi.fn(),
	signMessage: vi.fn(),
	switchChain: vi.fn(),
	waitForTransactionReceipt: vi.fn(),
}));

const CHECKSUM_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const USDC = "0x1111111111111111111111111111111111111111";
const TX_HASH = repeatedHex("ab", 32);
const SIGNATURE = repeatedHex("11", 65);

describe("wagmi wallet session", () => {
	beforeEach(() => {
		vi.mocked(getConnection).mockReturnValue(disconnected());
		vi.mocked(connect).mockResolvedValue({
			accounts: [CHECKSUM_ADDRESS],
			chainId: 31_337,
		});
		vi.mocked(signMessage).mockResolvedValue(SIGNATURE);
		vi.mocked(sendTransaction).mockResolvedValue(TX_HASH);
		vi.mocked(getTransactionCount).mockResolvedValue(0);
		vi.mocked(switchChain).mockResolvedValue(wagmiConfig.chains[2]);
		vi.mocked(waitForTransactionReceipt).mockResolvedValue(
			transactionReceipt("success"),
		);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("登录 API 不可达时明确提示服务故障，不触发钱包弹窗", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
		);
		await expect(connectWalletSession()).rejects.toThrow("无法连接登录服务");
		expect(connect).not.toHaveBeenCalled();
		expect(signMessage).not.toHaveBeenCalled();
	});

	it("会话恢复不能把服务故障当成未登录", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
		);
		const { restoreWalletSession } = await import("./wallet-session");
		await expect(restoreWalletSession()).rejects.toThrow("登录服务暂时不可用");
	});

	it("connects MetaMask on the SIWE-requested chain and compares checksum addresses case-insensitively", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					nonce: "aicpNonce123",
					expiresAt: "2026-08-23T15:00:00.000Z",
					domain: "127.0.0.1:3001",
					uri: "http://127.0.0.1:3001",
					chainId: 31_337,
					statement: "登录 AICP",
				}),
			)
			.mockResolvedValueOnce(
				jsonResponse({ walletAddress: CHECKSUM_ADDRESS.toLowerCase() }),
			);
		vi.stubGlobal("fetch", fetcher);

		await expect(connectWalletSession()).resolves.toEqual({
			walletAddress: CHECKSUM_ADDRESS,
			chainId: 31_337,
		});
		expect(connect).toHaveBeenCalledWith(
			wagmiConfig,
			expect.objectContaining({
				chainId: 31_337,
				connector: metaMaskConnector,
			}),
		);
		expect(signMessage).toHaveBeenCalledWith(
			wagmiConfig,
			expect.objectContaining({
				account: CHECKSUM_ADDRESS,
				message: expect.stringContaining(CHECKSUM_ADDRESS),
			}),
		);
		expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
			signature: SIGNATURE,
		});
	});

	it("restores the server-authoritative transaction chain without connecting MetaMask", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				jsonResponse({
					authenticated: true,
					walletAddress: CHECKSUM_ADDRESS,
					chainId: 31_337,
				}),
			),
		);

		const { restoreWalletSession } = await import("./wallet-session");
		await expect(restoreWalletSession()).resolves.toEqual({
			walletAddress: CHECKSUM_ADDRESS.toLowerCase(),
			chainId: 31_337,
		});
		expect(connect).not.toHaveBeenCalled();
	});

	it("仅在服务端会话恢复后静默重连已授权的 MetaMask", async () => {
		vi.mocked(reconnect).mockResolvedValue([]);

		await expect(restoreAuthorizedWalletConnection()).resolves.toBeUndefined();

		expect(reconnect).toHaveBeenCalledWith(wagmiConfig, {
			connectors: [metaMaskConnector],
		});
		expect(connect).not.toHaveBeenCalled();
	});

	it("静默重连失败时保留服务端登录恢复路径", async () => {
		vi.mocked(reconnect).mockRejectedValue(new Error("extension unavailable"));

		await expect(restoreAuthorizedWalletConnection()).resolves.toBeUndefined();
	});

	it("logs out through the server without disconnecting the MetaMask connector", async () => {
		const fetcher = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetcher);

		await expect(logoutWalletSession()).resolves.toBeUndefined();

		expect(fetcher).toHaveBeenCalledWith(
			expect.stringContaining("/auth/session"),
			{
				method: "DELETE",
				credentials: "include",
				signal: expect.any(AbortSignal),
			},
		);
		expect(connect).not.toHaveBeenCalled();
	});

	it("keeps logout failure explicit when the server cannot revoke the session", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json(
					{
						message: "退出登录暂时失败，请稍后重试",
					},
					{ status: 503 },
				),
			),
		);

		await expect(logoutWalletSession()).rejects.toThrow("退出登录暂时失败");
	});

	it("refuses to submit escrow from an account different from the authenticated wallet", async () => {
		vi.mocked(connect).mockResolvedValue({
			accounts: ["0x1111111111111111111111111111111111111111"],
			chainId: 31_337,
		});

		await expect(
			sendEscrowTransaction({
				walletAddress: CHECKSUM_ADDRESS,
				chainId: 31_337,
				transaction: { to: CONTRACT, data: "0x1234", value: "0x0" },
			}),
		).rejects.toThrow("当前 MetaMask 账户与登录钱包不一致");
		expect(sendTransaction).not.toHaveBeenCalled();
	});

	it("uses viem-validated transaction fields and returns only the submitted transaction hash", async () => {
		await expect(
			sendEscrowTransaction({
				walletAddress: CHECKSUM_ADDRESS,
				chainId: 31_337,
				transaction: { to: CONTRACT, data: "0x1234", value: "0x0" },
			}),
		).resolves.toBe(TX_HASH);

		expect(sendTransaction).toHaveBeenCalledWith(
			wagmiConfig,
			expect.objectContaining({
				account: CHECKSUM_ADDRESS,
				chainId: 31_337,
				nonce: 0,
				to: CONTRACT,
				data: "0x1234",
				value: BigInt(0),
			}),
		);
		expect(getTransactionCount).toHaveBeenCalledWith(wagmiConfig, {
			address: CHECKSUM_ADDRESS,
			blockTag: "pending",
			chainId: 31_337,
		});
	});

	it("leaves nonce management to the wallet outside local Anvil", async () => {
		await expect(
			sendEscrowTransaction({
				walletAddress: CHECKSUM_ADDRESS,
				chainId: 11_155_111,
				transaction: { to: CONTRACT, data: "0x1234", value: "0x0" },
			}),
		).resolves.toBe(TX_HASH);

		expect(getTransactionCount).not.toHaveBeenCalled();
		expect(sendTransaction).toHaveBeenCalledWith(
			wagmiConfig,
			expect.not.objectContaining({ nonce: expect.any(Number) }),
		);
	});

	it("ends a wallet request that never returns instead of leaving the page busy forever", async () => {
		vi.useFakeTimers();
		vi.mocked(sendTransaction).mockImplementation(
			() => new Promise<never>(() => undefined),
		);

		const submission = sendEscrowTransaction({
			walletAddress: CHECKSUM_ADDRESS,
			chainId: 31_337,
			transaction: { to: CONTRACT, data: "0x1234", value: "0x0" },
		});
		const result = submission.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(60_000);

		const error = await result;
		expect(error).toBeInstanceOf(WalletRequestTimeoutError);
		expect(error).toHaveProperty(
			"message",
			expect.stringContaining("请先打开 MetaMask 检查"),
		);
	});

	it("rejects any native-token value before opening an escrow wallet request", async () => {
		await expect(
			sendEscrowTransaction({
				walletAddress: CHECKSUM_ADDRESS,
				chainId: 31_337,
				transaction: { to: CONTRACT, data: "0x1234", value: "0x1" },
			}),
		).rejects.toThrow("USDC 托管交易不能携带原生代币");
		expect(connect).not.toHaveBeenCalled();
	});

	it("rejects an unconfigured chain before opening a wallet request", async () => {
		await expect(
			sendEscrowTransaction({
				walletAddress: CHECKSUM_ADDRESS,
				chainId: 99_999,
				transaction: { to: CONTRACT, data: "0x1234", value: "0x0" },
			}),
		).rejects.toThrow("尚未配置 Chain ID 99999");
		expect(connect).not.toHaveBeenCalled();
	});

	it("reuses an already confirmed exact USDC allowance without another wallet request", async () => {
		vi.mocked(readContract).mockResolvedValue(BigInt(32_000_000));

		await expect(
			ensureEscrowAllowance(allowanceInput()),
		).resolves.toBeUndefined();

		expect(readContract).toHaveBeenCalledTimes(1);
		expect(sendTransaction).not.toHaveBeenCalled();
		expect(waitForTransactionReceipt).not.toHaveBeenCalled();
	});

	it("waits for exact USDC approval confirmation before allowing deposit", async () => {
		vi.mocked(readContract)
			.mockResolvedValueOnce(BigInt(0))
			.mockResolvedValueOnce(BigInt(32_000_000));

		await expect(
			ensureEscrowAllowance(allowanceInput()),
		).resolves.toBeUndefined();

		expect(sendTransaction).toHaveBeenCalledTimes(1);
		expect(waitForTransactionReceipt).toHaveBeenCalledWith(
			wagmiConfig,
			expect.objectContaining({ chainId: 31_337, hash: TX_HASH }),
		);
		expect(readContract).toHaveBeenCalledTimes(2);
	});

	it("stops before deposit when a successful receipt does not produce the exact allowance", async () => {
		vi.mocked(readContract)
			.mockResolvedValueOnce(BigInt(0))
			.mockResolvedValueOnce(BigInt(31_999_999));

		await expect(ensureEscrowAllowance(allowanceInput())).rejects.toThrow(
			"授权额度未正确生效",
		);
	});

	it("ends a stuck local approval receipt wait with an actionable recovery message", async () => {
		vi.useFakeTimers();
		vi.mocked(readContract).mockResolvedValue(BigInt(0));
		vi.mocked(waitForTransactionReceipt).mockImplementation(
			() => new Promise<never>(() => undefined),
		);

		const approval = ensureEscrowAllowance(allowanceInput());
		const result = approval.catch((error: unknown) => error);
		await vi.advanceTimersByTimeAsync(30_000);

		const error = await result;
		expect(error).toBeInstanceOf(WalletRequestTimeoutError);
		expect(error).toHaveProperty(
			"message",
			expect.stringContaining("USDC 授权交易长时间未确认"),
		);
	});
});

function allowanceInput() {
	return {
		walletAddress: CHECKSUM_ADDRESS,
		chainId: 31_337,
		paymentTokenAddress: USDC,
		escrowContractAddress: CONTRACT,
		amountMinor: "32000000",
		approveTransaction: { to: USDC, data: "0x1234", value: "0x0" },
	} as const;
}

function transactionReceipt(
	status: "success" | "reverted",
): Awaited<ReturnType<typeof waitForTransactionReceipt>> {
	// 单元测试只依赖回执终态；其余 RPC 字段属于 wagmi 的外部边界，不影响本模块契约。
	return { status } as Awaited<ReturnType<typeof waitForTransactionReceipt>>;
}

function disconnected(): ReturnType<typeof getConnection> {
	return {
		address: undefined,
		addresses: undefined,
		chain: undefined,
		chainId: undefined,
		connector: undefined,
		isConnected: false,
		isConnecting: false,
		isDisconnected: true,
		isReconnecting: false,
		status: "disconnected",
	};
}

function jsonResponse(body: unknown): Response {
	return Response.json(body);
}

function repeatedHex(byte: string, count: number): `0x${string}` {
	return `0x${byte.repeat(count)}`;
}
