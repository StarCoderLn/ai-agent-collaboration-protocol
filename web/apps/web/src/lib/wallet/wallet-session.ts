import { z } from "zod";
import { connect, getConnection, sendTransaction, signMessage, switchChain } from "wagmi/actions";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

import { BUSINESS_API_BASE_URL } from "../api/base-url";
import { metaMaskConnector, requireSupportedChainId, wagmiConfig } from "./wagmi-config";

const nonceSchema = z.object({
	nonce: z.string().regex(/^[a-zA-Z0-9]{8,}$/),
	expiresAt: z.iso.datetime(),
	domain: z.string().min(1),
	uri: z.url(),
	chainId: z.number().int().positive(),
	statement: z.string().min(1),
});
const authenticatedSchema = z.object({ authenticated: z.literal(true), walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
const verifiedSchema = z.object({ walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) });
const authErrorSchema = z.object({ message: z.string().min(1) }).passthrough();

export type WalletSession = Readonly<{ walletAddress: string }>;

export async function restoreWalletSession(): Promise<WalletSession | null> {
	let response: Response;
	try {
		response = await fetch(`${BUSINESS_API_BASE_URL}/auth/session`, { credentials: "include" });
	} catch { return null; }
	if (!response.ok) return null;
	const parsed = authenticatedSchema.safeParse(await safeJson(response));
	return parsed.success ? { walletAddress: parsed.data.walletAddress.toLowerCase() } : null;
}

export async function connectWalletSession(): Promise<WalletSession> {
	const nonceResponse = await fetch(`${BUSINESS_API_BASE_URL}/auth/nonce`, { credentials: "include" });
	const nonce = nonceSchema.safeParse(await safeJson(nonceResponse));
	if (!nonceResponse.ok || !nonce.success) throw new Error("无法获取安全登录挑战，请稍后重试");

	const chainId = requireSupportedChainId(nonce.data.chainId);
	const walletAddress = await connectMetaMask(chainId);
	const message = buildSiweMessage({ ...nonce.data, walletAddress, issuedAt: new Date().toISOString() });
	const signature = await walletAction(
		() => signMessage(wagmiConfig, { account: walletAddress, message }),
		"钱包没有返回有效签名",
	);
	const verifyResponse = await fetch(`${BUSINESS_API_BASE_URL}/auth/verify`, {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message, signature }),
	});
	const verified = verifiedSchema.safeParse(await safeJson(verifyResponse));
	if (!verifyResponse.ok || !verified.success || verified.data.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
		throw new Error("钱包签名验证失败，请确认网络和账户后重试");
	}
	return { walletAddress };
}

/**
 * 退出登录由服务端吊销不透明会话并覆盖 httpOnly Cookie。这里不调用 wagmi disconnect：
 * 平台登录状态与浏览器钱包扩展连接是两件事，退出 AICP 不应替用户断开 MetaMask。
 */
export async function logoutWalletSession(): Promise<void> {
	let response: Response;
	try {
		response = await fetch(`${BUSINESS_API_BASE_URL}/auth/session`, {
			method: "DELETE",
			credentials: "include",
		});
	} catch {
		throw new Error("退出登录失败，请检查网络后重试");
	}
	if (!response.ok) {
		const parsed = authErrorSchema.safeParse(await safeJson(response));
		throw new Error(parsed.success ? parsed.data.message : "退出登录暂时失败，请稍后重试");
	}
}

/**
 * 发送交易只返回钱包接受后的 tx hash。平台是否确认托管仍由后端链事件同步器判断，
 * 因此调用方必须继续上报 submitted，不能在这里直接把任务标记为已托管。
 */
export async function sendEscrowTransaction(input: Readonly<{
	walletAddress: string;
	chainId: number;
	transaction: Readonly<{ to: string; data: string; value: string }>;
}>): Promise<string> {
	if (!isAddress(input.walletAddress) || !isAddress(input.transaction.to)
		|| !isHex(input.transaction.data) || !isHex(input.transaction.value)) {
		throw new Error("服务端返回的托管交易格式无效");
	}
	const chainId = requireSupportedChainId(input.chainId);
	const walletAddress = getAddress(input.walletAddress);
	const activeAddress = await connectMetaMask(chainId);
	if (activeAddress.toLowerCase() !== walletAddress.toLowerCase()) {
		throw new Error("当前 MetaMask 账户与登录钱包不一致，请重新连接钱包");
	}
	return walletAction(
		() => sendTransaction(wagmiConfig, {
			account: walletAddress,
			chainId,
			to: getAddress(input.transaction.to),
			data: input.transaction.data as Hex,
			value: BigInt(input.transaction.value),
		}),
		"托管交易未能提交到 MetaMask",
	);
}

export function buildSiweMessage(input: Readonly<{
	domain: string; uri: string; chainId: number; nonce: string; statement: string;
	walletAddress: string; issuedAt: string;
}>): string {
	return `${input.domain} wants you to sign in with your Ethereum account:\n${input.walletAddress}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: 1\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}`;
}

async function safeJson(response: Response): Promise<unknown> {
	try { return await response.json(); }
	catch { return null; }
}

async function connectMetaMask(chainId: ReturnType<typeof requireSupportedChainId>): Promise<Address> {
	const current = getConnection(wagmiConfig);
	if (current.status === "connected") {
		if (current.chainId !== chainId) {
			await walletAction(
				() => switchChain(wagmiConfig, { chainId, connector: current.connector }),
				`请在 MetaMask 中切换到 Chain ID ${chainId}`,
			);
		}
		return current.address;
	}
	const result = await walletAction(
		() => connect(wagmiConfig, { connector: metaMaskConnector, chainId }),
		"未检测到可用的 MetaMask，请先安装或解锁钱包扩展",
	);
	return result.accounts[0];
}

async function walletAction<T>(action: () => Promise<T>, fallback: string): Promise<T> {
	try { return await action(); }
	catch (error) {
		const shortMessage = typeof error === "object" && error !== null && "shortMessage" in error
			&& typeof error.shortMessage === "string" ? error.shortMessage : null;
		throw new Error(shortMessage ?? fallback);
	}
}
