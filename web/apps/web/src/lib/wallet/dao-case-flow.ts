import { erc20Abi, getAddress, type Hex } from "viem";
import {
	connect,
	getConnection,
	getTransactionCount,
	readContract,
	sendTransaction,
	switchChain,
	waitForTransactionReceipt,
	writeContract,
} from "wagmi/actions";
import {
	type ChainArbitration,
	confirmDaoEvidence,
	type DaoCaseAction,
	prepareDaoCaseAction,
} from "@/lib/api/dao-cases";
import {
	anvil,
	metaMaskConnector,
	requireSupportedChainId,
	wagmiConfig,
} from "./wagmi-config";

export type DaoCaseWalletStage =
	| "preparing"
	| "authorizing"
	| "submitting"
	| "confirming";

// MetaMask 委托账户有时会为普通调用填入 21,000,000 Gas，超过 Sepolia RPC 的
// 单笔上限。案件动作的最坏路径远低于该值，因此在钱包边界统一约束，避免各按钮重复配置。
const DAO_CASE_TRANSACTION_GAS_LIMIT = BigInt(1_000_000);

const SAFE_DAO_CASE_ERRORS = new Set([
	"案件合约配置已变化，请刷新页面后重试",
	"请连接与登录身份相同的钱包",
	"申诉条款已变化，请刷新并核对费用",
	"申诉费用不一致，请刷新案件",
	"钱包账户已切换或网络已变化，请重新确认操作",
	"链上交易未执行成功，请查看交易详情",
]);

/** 钱包和 RPC 错误只能用于分类，原始节点地址、calldata 和调用栈不得进入产品界面。 */
export function daoCaseWalletErrorMessage(error: unknown, en: boolean): string {
	const details = walletErrorDetails(error);
	const original = error instanceof Error ? error.message : "";
	if (SAFE_DAO_CASE_ERRORS.has(original)) return original;
	if (
		details.includes("4001") ||
		/user (rejected|denied)|request rejected|用户.*(拒绝|取消)/.test(details)
	)
		return en
			? "You cancelled the wallet request. No transaction was sent."
			: "你已取消钱包操作，交易尚未发送。";
	if (/gas limit too high|exceeds.*gas|gas.*cap/.test(details))
		return en
			? "The wallet supplied an invalid gas limit, so the transaction was not sent. Refresh the page and try again."
			: "钱包给出的 Gas 上限异常，交易尚未发送。请刷新页面后重试。";
	if (/insufficient funds|exceeds balance/.test(details))
		return en
			? "This wallet does not have enough network fees to send the transaction."
			: "当前钱包的网络手续费不足，交易尚未发送。";
	if (/timeout|timed out|等待.*超时/.test(details))
		return en
			? "Confirmation is taking longer than expected. Check the saved transaction hash before signing again."
			: "交易确认时间较长，请先核验页面保存的交易哈希，不要重复签名。";
	if (/revert|execution failed|call exception/.test(details))
		return en
			? "The onchain operation failed. Funds and case status were unchanged. Refresh the case and try again."
			: "链上执行失败，资金和案件状态未改变。请刷新案件后重试。";
	return en
		? "The operation could not be completed. Refresh the case and try again."
		: "操作未完成，请刷新案件后重试。";
}

function walletErrorDetails(error: unknown): string {
	const details: string[] = [];
	let current = error;
	for (
		let depth = 0;
		depth < 5 && typeof current === "object" && current;
		depth++
	) {
		if (current instanceof Error) details.push(current.name, current.message);
		if ("shortMessage" in current && typeof current.shortMessage === "string")
			details.push(current.shortMessage);
		if ("code" in current && ["string", "number"].includes(typeof current.code))
			details.push(String(current.code));
		current = "cause" in current ? current.cause : undefined;
	}
	return details.join(" ").toLowerCase();
}

/**
 * 案件操作仅在用户点击后执行。申诉的 approve 和 appeal 是两个独立步骤，前者成功后
 * 不等于申诉受理。授权只给本次保证金与服务费总额，不请求无限额度、不动任务预算。
 */
export async function executeDaoCaseAction(
	input: Readonly<{
		disputeId: string;
		walletAddress: string;
		caseInfo: ChainArbitration;
		action: DaoCaseAction;
		onProgress(stage: DaoCaseWalletStage): void;
		onBroadcast(hash: Hex): void;
	}>,
): Promise<Hex> {
	input.onProgress("preparing");
	const prepared = await prepareDaoCaseAction(input.disputeId, input.action);
	if (
		prepared.to !== input.caseInfo.contractAddress ||
		prepared.chainId !== input.caseInfo.chainId ||
		prepared.action !== input.action.action
	) {
		throw new Error("案件合约配置已变化，请刷新页面后重试");
	}
	const chainId = requireSupportedChainId(Number(BigInt(prepared.chainId)));
	const account = getAddress(input.walletAddress);
	let connection = getConnection(wagmiConfig);
	// SIWE Cookie 可以在刷新后恢复登录身份，但 injected connector 只允许在用户主动
	// 操作时注册。案件按钮本身就是用户手势，因此此处恢复链连接，再继续核对同一钱包。
	if (connection.status !== "connected") {
		await connect(wagmiConfig, { connector: metaMaskConnector, chainId });
		connection = getConnection(wagmiConfig);
	}
	if (
		connection.status !== "connected" ||
		connection.address.toLowerCase() !== account.toLowerCase()
	)
		throw new Error("请连接与登录身份相同的钱包");
	if (connection.chainId !== chainId)
		await switchChain(wagmiConfig, {
			chainId,
			connector: connection.connector,
		});
	if (input.action.action === "appeal") {
		const terms = input.caseInfo.snapshot;
		if (
			terms === null ||
			terms.appealBondMinor !== prepared.appealBondMinor ||
			terms.appealFeeMinor !== prepared.appealFeeMinor ||
			terms.bondPolicy !== prepared.bondPolicy
		) {
			throw new Error("申诉条款已变化，请刷新并核对费用");
		}
		const amount = BigInt(prepared.approvalAmountMinor);
		if (amount !== BigInt(terms.appealBondMinor) + BigInt(terms.appealFeeMinor))
			throw new Error("申诉费用不一致，请刷新案件");
		const token = getAddress(prepared.paymentTokenAddress);
		const spender = getAddress(prepared.to);
		const allowance = await readContract(wagmiConfig, {
			chainId,
			address: token,
			abi: erc20Abi,
			functionName: "allowance",
			args: [account, spender],
		});
		if (allowance < amount) {
			input.onProgress("authorizing");
			const nonce = await localNonce(chainId, account);
			requireCurrentWallet(chainId, account);
			const hash = await writeContract(wagmiConfig, {
				chainId,
				account,
				address: token,
				abi: erc20Abi,
				functionName: "approve",
				args: [spender, amount],
				gas: DAO_CASE_TRANSACTION_GAS_LIMIT,
				nonce,
			});
			await confirmed(chainId, hash);
		}
	}
	input.onProgress("submitting");
	const nonce = await localNonce(chainId, account);
	requireCurrentWallet(chainId, account);
	const hash = await sendTransaction(wagmiConfig, {
		chainId,
		account,
		to: getAddress(prepared.to),
		value: BigInt(0),
		// API 边界已经验证 0x 十六进制 calldata，此处仅收窄 viem 的 Hex 模板类型。
		data: prepared.data as Hex,
		gas: DAO_CASE_TRANSACTION_GAS_LIMIT,
		nonce,
	});
	input.onBroadcast(hash);
	input.onProgress("confirming");
	await confirmed(chainId, hash);
	if (input.action.action === "evidence")
		await confirmDaoEvidence(input.disputeId, input.action.evidenceId, hash);
	return hash;
}

/** 切链、授权和 nonce 查询都可能让用户切换身份；每次签名前须在最后一次 await 后复核。 */
function requireCurrentWallet(chainId: number, account: Hex): void {
	const connection = getConnection(wagmiConfig);
	if (
		connection.status !== "connected" ||
		connection.address.toLowerCase() !== account.toLowerCase() ||
		connection.chainId !== chainId
	)
		throw new Error("钱包账户已切换或网络已变化，请重新确认操作");
}

/** 仅本地链修正钱包跨实例 nonce 缓存；真实测试网继续交给钱包管理队列。 */
async function localNonce(
	chainId: ReturnType<typeof requireSupportedChainId>,
	account: Hex,
) {
	return chainId === anvil.id
		? getTransactionCount(wagmiConfig, {
				chainId,
				address: account,
				blockTag: "pending",
			})
		: undefined;
}

/** 钱包返回哈希只是已广播，只有成功回执才能显示操作完成；超时仍保留哈希供查询。 */
async function confirmed(
	chainId: ReturnType<typeof requireSupportedChainId>,
	hash: Hex,
) {
	const receipt = await waitForTransactionReceipt(wagmiConfig, {
		chainId,
		hash,
		pollingInterval: 1_000,
		timeout: 90_000,
	});
	if (receipt.status !== "success")
		throw new Error("链上交易未执行成功，请查看交易详情");
}
