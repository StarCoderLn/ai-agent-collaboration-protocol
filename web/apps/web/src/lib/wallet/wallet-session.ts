import {
	type Address,
	erc20Abi,
	getAddress,
	type Hex,
	isAddress,
	isHex,
} from "viem";
import {
	connect,
	getConnection,
	readContract,
	sendTransaction,
	signMessage,
	switchChain,
	waitForTransactionReceipt,
} from "wagmi/actions";
import { z } from "zod";

import { BUSINESS_API_BASE_URL } from "../api/base-url";
import {
	metaMaskConnector,
	requireSupportedChainId,
	wagmiConfig,
} from "./wagmi-config";

const nonceSchema = z.object({
	nonce: z.string().regex(/^[a-zA-Z0-9]{8,}$/),
	expiresAt: z.iso.datetime(),
	domain: z.string().min(1),
	uri: z.url(),
	chainId: z.number().int().positive(),
	statement: z.string().min(1),
});
const authenticatedSchema = z.object({
	authenticated: z.literal(true),
	walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
const verifiedSchema = z.object({
	walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});
const authErrorSchema = z.object({ message: z.string().min(1) }).passthrough();

export type WalletSession = Readonly<{ walletAddress: string }>;

export async function restoreWalletSession(): Promise<WalletSession | null> {
	let response: Response;
	try {
		response = await fetch(`${BUSINESS_API_BASE_URL}/auth/session`, {
			credentials: "include",
		});
	} catch {
		return null;
	}
	if (!response.ok) return null;
	const parsed = authenticatedSchema.safeParse(await safeJson(response));
	return parsed.success
		? { walletAddress: parsed.data.walletAddress.toLowerCase() }
		: null;
}

export async function connectWalletSession(): Promise<WalletSession> {
	const nonceResponse = await fetch(`${BUSINESS_API_BASE_URL}/auth/nonce`, {
		credentials: "include",
	});
	const nonce = nonceSchema.safeParse(await safeJson(nonceResponse));
	if (!nonceResponse.ok || !nonce.success)
		throw new Error("无法获取安全登录挑战，请稍后重试");

	const chainId = requireSupportedChainId(nonce.data.chainId);
	const walletAddress = await connectMetaMask(chainId);
	const message = buildSiweMessage({
		...nonce.data,
		walletAddress,
		issuedAt: new Date().toISOString(),
	});
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
	if (
		!verifyResponse.ok ||
		!verified.success ||
		verified.data.walletAddress.toLowerCase() !== walletAddress.toLowerCase()
	) {
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
		throw new Error(
			parsed.success ? parsed.data.message : "退出登录暂时失败，请稍后重试",
		);
	}
}

/**
 * 发送交易只返回钱包接受后的 tx hash。平台是否确认托管仍由后端链事件同步器判断，
 * 因此调用方必须继续上报 submitted，不能在这里直接把任务标记为已托管。
 */
export async function sendEscrowTransaction(
	input: Readonly<{
		walletAddress: string;
		chainId: number;
		transaction: Readonly<{ to: string; data: string; value: string }>;
	}>,
): Promise<string> {
	if (
		!isAddress(input.walletAddress) ||
		!isAddress(input.transaction.to) ||
		!isHex(input.transaction.data) ||
		!isHex(input.transaction.value)
	) {
		throw new Error("服务端返回的托管交易格式无效");
	}
	// USDC 的 approve/deposit 都通过 calldata 指定金额，原生 value 必须为零。
	// 在钱包边界再次检查，防止被污染的服务端响应诱导用户额外发送 ETH。
	if (BigInt(input.transaction.value) !== BigInt(0)) {
		throw new Error("USDC 托管交易不能携带原生代币");
	}
	const chainId = requireSupportedChainId(input.chainId);
	const walletAddress = getAddress(input.walletAddress);
	const activeAddress = await connectMetaMask(chainId);
	if (activeAddress.toLowerCase() !== walletAddress.toLowerCase()) {
		throw new Error("当前 MetaMask 账户与登录钱包不一致，请重新连接钱包");
	}
	return walletAction(
		() =>
			sendTransaction(wagmiConfig, {
				account: walletAddress,
				chainId,
				to: getAddress(input.transaction.to),
				data: input.transaction.data as Hex,
				value: BigInt(0),
			}),
		"托管交易未能提交到 MetaMask",
	);
}

/**
 * 在发送 deposit 之前建立一个可验证的授权边界：链上 allowance 必须恰好等于本任务金额。
 * 重试时如果上一次授权已经确认，就直接复用，不再让用户重复支付 Gas；额度不同则重新
 * 精确授权并等待回执，避免 deposit 在授权尚未进入区块时因 allowance 不足而失败。
 */
export async function ensureEscrowAllowance(
	input: Readonly<{
		walletAddress: string;
		chainId: number;
		paymentTokenAddress: string;
		escrowContractAddress: string;
		amountMinor: string;
		approveTransaction: Readonly<{
			to: string;
			data: string;
			value: string;
		}>;
	}>,
): Promise<void> {
	if (
		!isAddress(input.walletAddress) ||
		!isAddress(input.paymentTokenAddress) ||
		!isAddress(input.escrowContractAddress)
	) {
		throw new Error("服务端返回的 USDC 授权地址无效");
	}
	const chainId = requireSupportedChainId(input.chainId);
	const walletAddress = getAddress(input.walletAddress);
	const paymentTokenAddress = getAddress(input.paymentTokenAddress);
	const escrowContractAddress = getAddress(input.escrowContractAddress);
	const amountMinor = parsePositiveMinorAmount(input.amountMinor);

	// approve calldata 由服务端生成，但钱包边界仍需确认目标确实是当前支付代币。
	// 这能阻止被污染的响应把“授权”交易引导到无关合约。
	if (
		!isAddress(input.approveTransaction.to) ||
		getAddress(input.approveTransaction.to) !== paymentTokenAddress
	) {
		throw new Error("USDC 授权交易的目标合约不一致");
	}

	const allowance = await readEscrowAllowance({
		chainId,
		walletAddress,
		paymentTokenAddress,
		escrowContractAddress,
	});
	if (allowance === amountMinor) return;

	const approvalHash = await sendEscrowTransaction({
		walletAddress,
		chainId,
		transaction: input.approveTransaction,
	});
	const receipt = await walletAction(
		() =>
			waitForTransactionReceipt(wagmiConfig, {
				chainId,
				hash: approvalHash as Hex,
			}),
		"USDC 授权交易未能确认",
	);
	if (receipt.status !== "success") {
		throw new Error("USDC 授权交易执行失败，资金尚未托管");
	}

	// 不能只相信交易状态：支付代币属于外部合约，成功回执不保证它按 ERC-20 语义
	// 更新了 allowance。再次读取并校验精确额度后，才允许进入 deposit。
	const confirmedAllowance = await readEscrowAllowance({
		chainId,
		walletAddress,
		paymentTokenAddress,
		escrowContractAddress,
	});
	if (confirmedAllowance !== amountMinor) {
		throw new Error("USDC 授权额度未正确生效，资金尚未托管");
	}
}

export function buildSiweMessage(
	input: Readonly<{
		domain: string;
		uri: string;
		chainId: number;
		nonce: string;
		statement: string;
		walletAddress: string;
		issuedAt: string;
	}>,
): string {
	return `${input.domain} wants you to sign in with your Ethereum account:\n${input.walletAddress}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: 1\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}`;
}

async function safeJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function connectMetaMask(
	chainId: ReturnType<typeof requireSupportedChainId>,
): Promise<Address> {
	const current = getConnection(wagmiConfig);
	if (current.status === "connected") {
		if (current.chainId !== chainId) {
			await walletAction(
				() =>
					switchChain(wagmiConfig, { chainId, connector: current.connector }),
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

async function walletAction<T>(
	action: () => Promise<T>,
	fallback: string,
): Promise<T> {
	try {
		return await action();
	} catch (error) {
		const shortMessage =
			typeof error === "object" &&
			error !== null &&
			"shortMessage" in error &&
			typeof error.shortMessage === "string"
				? error.shortMessage
				: null;
		throw new Error(shortMessage ?? fallback);
	}
}

async function readEscrowAllowance(
	input: Readonly<{
		chainId: ReturnType<typeof requireSupportedChainId>;
		walletAddress: Address;
		paymentTokenAddress: Address;
		escrowContractAddress: Address;
	}>,
): Promise<bigint> {
	return readContract(wagmiConfig, {
		chainId: input.chainId,
		address: input.paymentTokenAddress,
		abi: erc20Abi,
		functionName: "allowance",
		args: [input.walletAddress, input.escrowContractAddress],
	});
}

function parsePositiveMinorAmount(value: string): bigint {
	if (!/^[1-9][0-9]*$/.test(value)) {
		throw new Error("USDC 授权金额必须是正整数最小单位");
	}
	return BigInt(value);
}
