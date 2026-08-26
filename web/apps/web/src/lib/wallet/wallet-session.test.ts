import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, getConnection, sendTransaction, signMessage, switchChain } from "wagmi/actions";

import { connectWalletSession, logoutWalletSession, sendEscrowTransaction } from "./wallet-session";
import { wagmiConfig } from "./wagmi-config";

vi.mock("wagmi/actions", () => ({
	connect: vi.fn(),
	getConnection: vi.fn(),
	sendTransaction: vi.fn(),
	signMessage: vi.fn(),
	switchChain: vi.fn(),
}));

const CHECKSUM_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
const TX_HASH = repeatedHex("ab", 32);
const SIGNATURE = repeatedHex("11", 65);

describe("wagmi wallet session", () => {
	beforeEach(() => {
		vi.mocked(getConnection).mockReturnValue(disconnected());
		vi.mocked(connect).mockResolvedValue({ accounts: [CHECKSUM_ADDRESS], chainId: 31_337 });
		vi.mocked(signMessage).mockResolvedValue(SIGNATURE);
		vi.mocked(sendTransaction).mockResolvedValue(TX_HASH);
		vi.mocked(switchChain).mockResolvedValue(wagmiConfig.chains[2]);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("connects MetaMask on the SIWE-requested chain and compares checksum addresses case-insensitively", async () => {
		const fetcher = vi.fn()
			.mockResolvedValueOnce(jsonResponse({
				nonce: "aicpNonce123",
				expiresAt: "2026-08-23T15:00:00.000Z",
				domain: "127.0.0.1:3001",
				uri: "http://127.0.0.1:3001",
				chainId: 31_337,
				statement: "登录 AICP",
			}))
			.mockResolvedValueOnce(jsonResponse({ walletAddress: CHECKSUM_ADDRESS.toLowerCase() }));
		vi.stubGlobal("fetch", fetcher);

		await expect(connectWalletSession()).resolves.toEqual({ walletAddress: CHECKSUM_ADDRESS });
		expect(connect).toHaveBeenCalledWith(wagmiConfig, expect.objectContaining({ chainId: 31_337 }));
		expect(signMessage).toHaveBeenCalledWith(wagmiConfig, expect.objectContaining({
			account: CHECKSUM_ADDRESS,
			message: expect.stringContaining(CHECKSUM_ADDRESS),
		}));
		expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
			signature: SIGNATURE,
		});
	});

	it("logs out through the server without disconnecting the MetaMask connector", async () => {
		const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetcher);

		await expect(logoutWalletSession()).resolves.toBeUndefined();

		expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/auth/session"), {
			method: "DELETE",
			credentials: "include",
		});
		expect(connect).not.toHaveBeenCalled();
	});

	it("keeps logout failure explicit when the server cannot revoke the session", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
			message: "退出登录暂时失败，请稍后重试",
		}, { status: 503 })));

		await expect(logoutWalletSession()).rejects.toThrow("退出登录暂时失败");
	});

	it("refuses to submit escrow from an account different from the authenticated wallet", async () => {
		vi.mocked(connect).mockResolvedValue({
			accounts: ["0x1111111111111111111111111111111111111111"],
			chainId: 31_337,
		});

		await expect(sendEscrowTransaction({
			walletAddress: CHECKSUM_ADDRESS,
			chainId: 31_337,
			transaction: { to: CONTRACT, data: "0x1234", value: "0x10" },
		})).rejects.toThrow("当前 MetaMask 账户与登录钱包不一致");
		expect(sendTransaction).not.toHaveBeenCalled();
	});

	it("uses viem-validated transaction fields and returns only the submitted transaction hash", async () => {
		await expect(sendEscrowTransaction({
			walletAddress: CHECKSUM_ADDRESS,
			chainId: 31_337,
			transaction: { to: CONTRACT, data: "0x1234", value: "0x10" },
		})).resolves.toBe(TX_HASH);

		expect(sendTransaction).toHaveBeenCalledWith(wagmiConfig, expect.objectContaining({
			account: CHECKSUM_ADDRESS,
			chainId: 31_337,
			to: CONTRACT,
			data: "0x1234",
			value: BigInt(16),
		}));
	});

	it("rejects an unconfigured chain before opening a wallet request", async () => {
		await expect(sendEscrowTransaction({
			walletAddress: CHECKSUM_ADDRESS,
			chainId: 99_999,
			transaction: { to: CONTRACT, data: "0x1234", value: "0x10" },
		})).rejects.toThrow("尚未配置 Chain ID 99999");
		expect(connect).not.toHaveBeenCalled();
	});
});

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
