import { erc20Abi, getAddress, type Hex } from "viem";
import {
	getConnection,
	getTransactionCount,
	readContract,
	switchChain,
	waitForTransactionReceipt,
	writeContract,
} from "wagmi/actions";

import { syncDaoMembership } from "@/lib/api/dao";
import { anvil, requireSupportedChainId, wagmiConfig } from "./wagmi-config";

const daoAbi = [
	{
		type: "function",
		name: "stake",
		stateMutability: "nonpayable",
		inputs: [{ name: "amount", type: "uint256" }],
		outputs: [],
	},
	{
		type: "function",
		name: "requestExit",
		stateMutability: "nonpayable",
		inputs: [],
		outputs: [],
	},
	{
		type: "function",
		name: "cancelExit",
		stateMutability: "nonpayable",
		inputs: [],
		outputs: [],
	},
	{
		type: "function",
		name: "withdraw",
		stateMutability: "nonpayable",
		inputs: [],
		outputs: [],
	},
] as const;

export type DaoMembershipCommand =
	| "stake"
	| "requestExit"
	| "cancelExit"
	| "withdraw";

/**
 * 钱包流程只接受服务端返回的链和合约目录。质押先核对 YD allowance 并等待授权回执，
 * 再发送 DAO 交易；最后只上报 txHash，由服务端独立核验事件和成员状态。
 */
export async function executeDaoMembershipCommand(
	input: Readonly<{
		command: DaoMembershipCommand;
		walletAddress: string;
		chainId: string;
		daoAddress: string;
		ydTokenAddress: string;
		amountMinor?: string;
		idempotencyKey: string;
		onProgress?(
			stage:
				| "switching"
				| "authorizing"
				| "submitting"
				| "confirming"
				| "syncing",
		): void;
	}>,
): Promise<void> {
	const chainId = requireSupportedChainId(Number(BigInt(input.chainId)));
	const walletAddress = getAddress(input.walletAddress);
	const daoAddress = getAddress(input.daoAddress);
	const ydTokenAddress = getAddress(input.ydTokenAddress);
	input.onProgress?.("switching");
	const connection = getConnection(wagmiConfig);
	if (
		connection.status !== "connected" ||
		connection.address.toLowerCase() !== walletAddress.toLowerCase()
	) {
		throw new Error("当前 MetaMask 账户与登录钱包不一致，请重新连接钱包");
	}
	if (connection.chainId !== chainId)
		await switchChain(wagmiConfig, {
			chainId,
			connector: connection.connector,
		});

	const amount =
		input.command === "stake" ? positiveAmount(input.amountMinor) : null;
	if (amount !== null) {
		const allowance = await readContract(wagmiConfig, {
			chainId,
			address: ydTokenAddress,
			abi: erc20Abi,
			functionName: "allowance",
			args: [walletAddress, daoAddress],
		});
		if (allowance < amount) {
			input.onProgress?.("authorizing");
			const nonce = await localNonce(chainId, walletAddress);
			const approvalHash = await writeContract(wagmiConfig, {
				chainId,
				account: walletAddress,
				address: ydTokenAddress,
				abi: erc20Abi,
				functionName: "approve",
				args: [daoAddress, amount],
				...(nonce === undefined ? {} : { nonce }),
			});
			await confirmedReceipt(chainId, approvalHash, "YD 授权交易执行失败");
		}
	}

	input.onProgress?.("submitting");
	const txHash = await writeDaoCommand(
		chainId,
		walletAddress,
		daoAddress,
		input.command,
		amount,
	);
	input.onProgress?.("confirming");
	await confirmedReceipt(chainId, txHash, "DAO 成员交易执行失败");
	input.onProgress?.("syncing");
	await syncDaoMembership(txHash, input.idempotencyKey);
}

async function writeDaoCommand(
	chainId: ReturnType<typeof requireSupportedChainId>,
	walletAddress: `0x${string}`,
	daoAddress: `0x${string}`,
	command: DaoMembershipCommand,
	amount: bigint | null,
): Promise<Hex> {
	const nonce = await localNonce(chainId, walletAddress);
	const common = {
		chainId,
		account: walletAddress,
		address: daoAddress,
		abi: daoAbi,
		...(nonce === undefined ? {} : { nonce }),
	};
	// 显式分支保留每个合约函数的精确 ABI 类型，也让代码审查能够直接看到每个按钮究竟
	// 会调用哪个链上入口；不能用类型断言把任意字符串伪装成合法函数名。
	if (command === "stake") {
		if (amount === null) throw new Error("YD 质押数量缺失");
		return writeContract(wagmiConfig, {
			...common,
			functionName: "stake",
			args: [amount],
		});
	}
	if (command === "requestExit") {
		return writeContract(wagmiConfig, {
			...common,
			functionName: "requestExit",
			args: [],
		});
	}
	if (command === "cancelExit") {
		return writeContract(wagmiConfig, {
			...common,
			functionName: "cancelExit",
			args: [],
		});
	}
	return writeContract(wagmiConfig, {
		...common,
		functionName: "withdraw",
		args: [],
	});
}

async function localNonce(
	chainId: ReturnType<typeof requireSupportedChainId>,
	walletAddress: `0x${string}`,
): Promise<number | undefined> {
	// 本地 Anvil 的立即出块与钱包缓存偶尔会让连续 approve/stake 复用旧 nonce；仅本地链
	// 显式读取 pending nonce，真实测试网交给钱包管理，避免改变用户熟悉的交易排队语义。
	return chainId === anvil.id
		? getTransactionCount(wagmiConfig, {
				address: walletAddress,
				chainId,
				blockTag: "pending",
			})
		: undefined;
}

async function confirmedReceipt(
	chainId: ReturnType<typeof requireSupportedChainId>,
	hash: Hex,
	message: string,
): Promise<void> {
	// 钱包返回 txHash 只代表交易已提交，只有成功回执才允许同步服务端成员资格。
	const receipt = await waitForTransactionReceipt(wagmiConfig, {
		chainId,
		hash,
	});
	if (receipt.status !== "success") throw new Error(message);
}

function positiveAmount(value: string | undefined): bigint {
	if (value === undefined || !/^[1-9][0-9]*$/.test(value))
		throw new Error("YD 质押数量必须是正整数最小单位");
	return BigInt(value);
}
