import {
	type Address,
	createPublicClient,
	decodeEventLog,
	getAddress,
	type Hex,
	http,
	isAddress,
	parseAbi,
	TransactionNotFoundError,
	TransactionReceiptNotFoundError,
} from "viem";

const TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

const ESCROW_EVENT_ABI = parseAbi([
	"event Deposited(bytes32 indexed taskId,address indexed payer,uint256 amount)",
	"event Released(bytes32 indexed taskId,address indexed payee,uint256 escrowAmount,uint256 agentGrossAmount,uint256 feeAmount,uint256 payerRefundAmount)",
	"event MilestoneReleased(bytes32 indexed taskId,address indexed payee,uint256 escrowAmount,uint256 milestoneGrossAmount,uint256 feeAmount,uint256 totalReleasedAmount,uint256 remainingAmount)",
	"event Finalized(bytes32 indexed taskId,address indexed payer,uint256 escrowAmount,uint256 releasedAmount,uint256 payerRefundAmount)",
	"event WorkflowPayoutReleased(bytes32 indexed taskId,uint256 indexed payoutIndex,address indexed payee,uint256 grossAmount,uint256 feeAmount,uint256 netAmount)",
	"event WorkflowSettled(bytes32 indexed taskId,bytes32 indexed settlementManifestHash,bytes32 indexed evidenceRoot,address payer,uint256 escrowAmount,uint256 totalGrossAmount,uint256 totalFeeAmount,uint256 payerRefundAmount)",
	"event Refunded(bytes32 indexed taskId,address indexed payer,uint256 escrowAmount,uint256 releasedAmount,uint256 payerRefundAmount)",
	"event DisputeRefunded(bytes32 indexed taskId,bytes32 indexed decisionHash,bytes32 indexed evidenceRoot,address payer,uint256 escrowAmount,uint256 payerRefundAmount)",
]);

const DAO_EVENT_ABI = parseAbi([
	"event StakeAdded(address indexed member,uint256 amount,uint256 totalStake)",
	"event ExitRequested(address indexed member,uint64 availableAt)",
	"event ExitCancelled(address indexed member)",
	"event StakeWithdrawn(address indexed member,uint256 amount)",
	"event MinimumStakeUpdated(uint256 previousAmount,uint256 newAmount)",
]);

const ERC20_EVENT_ABI = parseAbi([
	"event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export type KnownOnchainActivity =
	| Readonly<{
			kind: "escrow_deposit";
			logIndex: number;
			contractAddress: string;
			taskKey: string;
			payer: string;
			amountMinor: string;
	  }>
	| Readonly<{
			kind: "workflow_payout";
			logIndex: number;
			contractAddress: string;
			taskKey: string;
			payoutIndex: string;
			payee: string;
			grossAmountMinor: string;
			feeAmountMinor: string;
			netAmountMinor: string;
	  }>
	| Readonly<{
			kind: "workflow_settlement";
			logIndex: number;
			contractAddress: string;
			taskKey: string;
			settlementManifestHash: string;
			evidenceRoot: string;
			payer: string;
			escrowAmountMinor: string;
			totalGrossAmountMinor: string;
			totalFeeAmountMinor: string;
			payerRefundAmountMinor: string;
	  }>
	| Readonly<{
			kind: "escrow_release";
			logIndex: number;
			contractAddress: string;
			taskKey: string;
			payee: string;
			grossAmountMinor: string;
			feeAmountMinor: string;
			payerRefundAmountMinor: string;
	  }>
	| Readonly<{
			kind: "milestone_release";
			logIndex: number;
			contractAddress: string;
			taskKey: string;
			payee: string;
			grossAmountMinor: string;
			feeAmountMinor: string;
			payerRefundAmountMinor: string;
	  }>
	| Readonly<{
			kind: "escrow_finalized";
			logIndex: number;
			contractAddress: string;
			taskKey: string;
			payer: string;
			escrowAmountMinor: string;
			releasedAmountMinor: string;
			payerRefundAmountMinor: string;
	  }>
	| Readonly<{
			kind: "escrow_refund";
			logIndex: number;
			contractAddress: string;
			taskKey: string;
			payer: string;
			escrowAmountMinor: string;
			releasedAmountMinor: string;
			payerRefundAmountMinor: string;
	  }>
	| Readonly<{
			kind: "dispute_refund";
			logIndex: number;
			contractAddress: string;
			taskKey: string;
			decisionHash: string;
			evidenceRoot: string;
			payer: string;
			escrowAmountMinor: string;
			payerRefundAmountMinor: string;
	  }>
	| Readonly<{
			kind: "dao_stake";
			logIndex: number;
			contractAddress: string;
			member: string;
			amountMinor: string;
			totalStakeMinor: string;
	  }>
	| Readonly<{
			kind: "dao_exit_requested";
			logIndex: number;
			contractAddress: string;
			member: string;
			availableAt: string;
	  }>
	| Readonly<{
			kind: "dao_exit_cancelled";
			logIndex: number;
			contractAddress: string;
			member: string;
	  }>
	| Readonly<{
			kind: "dao_stake_withdrawn";
			logIndex: number;
			contractAddress: string;
			member: string;
			amountMinor: string;
	  }>
	| Readonly<{
			kind: "dao_minimum_stake_updated";
			logIndex: number;
			contractAddress: string;
			previousAmountMinor: string;
			newAmountMinor: string;
	  }>
	| Readonly<{
			kind: "token_transfer";
			logIndex: number;
			contractAddress: string;
			asset: "USDC" | "YD";
			decimals: number;
			from: string;
			to: string;
			amountMinor: string;
	  }>;

export type OnchainTransactionDetail = Readonly<{
	hash: string;
	chainId: number;
	chainName: string;
	status: "pending" | "success" | "reverted";
	blockNumber: string | null;
	blockHash: string | null;
	confirmations: string;
	timestamp: string | null;
	from: string;
	to: string | null;
	valueWei: string;
	nonce: number;
	gasLimit: string;
	gasUsed: string | null;
	effectiveGasPriceWei: string | null;
	feeWei: string | null;
	input: string;
	activities: readonly KnownOnchainActivity[];
}>;

export type TransactionLookupResult =
	| Readonly<{ kind: "found"; detail: OnchainTransactionDetail }>
	| Readonly<{ kind: "invalid_hash" }>
	| Readonly<{ kind: "not_found" }>;

type ConfiguredContracts = Readonly<{
	escrow: string | null;
	usdc: string | null;
	dao: string | null;
	yd: string | null;
}>;

/**
 * 详情页只读取当前部署环境的 RPC，不参与钱包签名或业务状态推进。合约地址由启动器注入，
 * 只有来自这些已知地址的日志才会被解释为平台业务事件，避免同签名的第三方事件被误标。
 */
export async function lookupTransaction(
	hashInput: string,
): Promise<TransactionLookupResult> {
	if (!TRANSACTION_HASH_PATTERN.test(hashInput))
		return { kind: "invalid_hash" };
	const hash = hashInput.toLowerCase() as Hex;
	const rpcUrl =
		process.env.NEXT_PUBLIC_ETHEREUM_RPC_URL ?? "http://127.0.0.1:8545";
	const client = createPublicClient({ transport: http(rpcUrl) });

	let transaction: Awaited<ReturnType<typeof client.getTransaction>>;
	try {
		transaction = await client.getTransaction({ hash });
	} catch (error) {
		if (error instanceof TransactionNotFoundError) return { kind: "not_found" };
		throw error;
	}

	let receipt: Awaited<ReturnType<typeof client.getTransactionReceipt>> | null;
	try {
		receipt = await client.getTransactionReceipt({ hash });
	} catch (error) {
		if (error instanceof TransactionReceiptNotFoundError) receipt = null;
		else throw error;
	}

	const chainId = await client.getChainId();
	const contracts = configuredContracts();
	if (receipt === null) {
		return {
			kind: "found",
			detail: {
				hash,
				chainId,
				chainName: chainName(chainId),
				status: "pending",
				blockNumber: null,
				blockHash: null,
				confirmations: "0",
				timestamp: null,
				from: transaction.from,
				to: transaction.to,
				valueWei: transaction.value.toString(),
				nonce: transaction.nonce,
				gasLimit: transaction.gas.toString(),
				gasUsed: null,
				effectiveGasPriceWei: null,
				feeWei: null,
				input: transaction.input,
				activities: [],
			},
		};
	}

	const [headBlockNumber, block] = await Promise.all([
		client.getBlockNumber(),
		client.getBlock({ blockNumber: receipt.blockNumber }),
	]);
	const confirmations =
		headBlockNumber >= receipt.blockNumber
			? headBlockNumber - receipt.blockNumber + BigInt(1)
			: BigInt(0);
	const effectiveGasPrice = receipt.effectiveGasPrice;

	return {
		kind: "found",
		detail: {
			hash,
			chainId,
			chainName: chainName(chainId),
			status: receipt.status,
			blockNumber: receipt.blockNumber.toString(),
			blockHash: receipt.blockHash,
			confirmations: confirmations.toString(),
			timestamp: new Date(Number(block.timestamp) * 1_000).toISOString(),
			from: transaction.from,
			to: transaction.to,
			valueWei: transaction.value.toString(),
			nonce: transaction.nonce,
			gasLimit: transaction.gas.toString(),
			gasUsed: receipt.gasUsed.toString(),
			effectiveGasPriceWei: effectiveGasPrice.toString(),
			feeWei: (receipt.gasUsed * effectiveGasPrice).toString(),
			input: transaction.input,
			activities: decodeKnownActivities(receipt.logs, contracts),
		},
	};
}

/** 日志解析集中在只读边界，页面组件不复制 ABI，也不自行猜测金额与地址字段位置。 */
function decodeKnownActivities(
	logs: readonly Readonly<{
		address: Address;
		data: Hex;
		topics: readonly [] | readonly [Hex, ...Hex[]];
		logIndex: number | null;
	}>[],
	contracts: ConfiguredContracts,
): readonly KnownOnchainActivity[] {
	const activities: KnownOnchainActivity[] = [];
	for (const log of logs) {
		const address = log.address.toLowerCase();
		const logIndex = log.logIndex ?? activities.length;
		if (contracts.escrow === address) {
			const activity = decodeEscrowActivity(log, logIndex);
			if (activity !== null) activities.push(activity);
			continue;
		}
		if (contracts.dao === address) {
			const activity = decodeDaoActivity(log, logIndex);
			if (activity !== null) activities.push(activity);
			continue;
		}
		const asset =
			contracts.usdc === address
				? "USDC"
				: contracts.yd === address
					? "YD"
					: null;
		if (asset !== null) {
			const transfer = decodeTransferActivity(log, logIndex, asset);
			if (transfer !== null) activities.push(transfer);
		}
	}
	return activities;
}

function decodeEscrowActivity(
	log: Readonly<{
		address: Address;
		data: Hex;
		topics: readonly [] | readonly [Hex, ...Hex[]];
	}>,
	logIndex: number,
): KnownOnchainActivity | null {
	try {
		const topics = eventTopics(log.topics);
		if (topics === null) return null;
		const decoded = decodeEventLog({
			abi: ESCROW_EVENT_ABI,
			data: log.data,
			topics,
			strict: true,
		});
		const contractAddress = log.address.toLowerCase();
		if (decoded.eventName === "Deposited") {
			return {
				kind: "escrow_deposit",
				logIndex,
				contractAddress,
				taskKey: decoded.args.taskId,
				payer: decoded.args.payer.toLowerCase(),
				amountMinor: decoded.args.amount.toString(),
			};
		}
		if (decoded.eventName === "WorkflowPayoutReleased") {
			return {
				kind: "workflow_payout",
				logIndex,
				contractAddress,
				taskKey: decoded.args.taskId,
				payoutIndex: decoded.args.payoutIndex.toString(),
				payee: decoded.args.payee.toLowerCase(),
				grossAmountMinor: decoded.args.grossAmount.toString(),
				feeAmountMinor: decoded.args.feeAmount.toString(),
				netAmountMinor: decoded.args.netAmount.toString(),
			};
		}
		if (decoded.eventName === "WorkflowSettled") {
			return {
				kind: "workflow_settlement",
				logIndex,
				contractAddress,
				taskKey: decoded.args.taskId,
				settlementManifestHash: decoded.args.settlementManifestHash,
				evidenceRoot: decoded.args.evidenceRoot,
				payer: decoded.args.payer.toLowerCase(),
				escrowAmountMinor: decoded.args.escrowAmount.toString(),
				totalGrossAmountMinor: decoded.args.totalGrossAmount.toString(),
				totalFeeAmountMinor: decoded.args.totalFeeAmount.toString(),
				payerRefundAmountMinor: decoded.args.payerRefundAmount.toString(),
			};
		}
		if (decoded.eventName === "Released") {
			return {
				kind: "escrow_release",
				logIndex,
				contractAddress,
				taskKey: decoded.args.taskId,
				payee: decoded.args.payee.toLowerCase(),
				grossAmountMinor: decoded.args.agentGrossAmount.toString(),
				feeAmountMinor: decoded.args.feeAmount.toString(),
				payerRefundAmountMinor: decoded.args.payerRefundAmount.toString(),
			};
		}
		if (decoded.eventName === "MilestoneReleased") {
			return {
				kind: "milestone_release",
				logIndex,
				contractAddress,
				taskKey: decoded.args.taskId,
				payee: decoded.args.payee.toLowerCase(),
				grossAmountMinor: decoded.args.milestoneGrossAmount.toString(),
				feeAmountMinor: decoded.args.feeAmount.toString(),
				payerRefundAmountMinor: "0",
			};
		}
		if (decoded.eventName === "Finalized" || decoded.eventName === "Refunded") {
			return {
				kind:
					decoded.eventName === "Finalized"
						? "escrow_finalized"
						: "escrow_refund",
				logIndex,
				contractAddress,
				taskKey: decoded.args.taskId,
				payer: decoded.args.payer.toLowerCase(),
				escrowAmountMinor: decoded.args.escrowAmount.toString(),
				releasedAmountMinor: decoded.args.releasedAmount.toString(),
				payerRefundAmountMinor: decoded.args.payerRefundAmount.toString(),
			};
		}
		if (decoded.eventName === "DisputeRefunded") {
			return {
				kind: "dispute_refund",
				logIndex,
				contractAddress,
				taskKey: decoded.args.taskId,
				decisionHash: decoded.args.decisionHash,
				evidenceRoot: decoded.args.evidenceRoot,
				payer: decoded.args.payer.toLowerCase(),
				escrowAmountMinor: decoded.args.escrowAmount.toString(),
				payerRefundAmountMinor: decoded.args.payerRefundAmount.toString(),
			};
		}
		return null;
	} catch {
		// 同一个平台合约会产生 AccessControl、Pausable 等其他事件；未知日志保留在回执中，
		// 但不会被错误解释成资金业务事件，也不会阻断整个详情页。
		return null;
	}
}

function decodeDaoActivity(
	log: Readonly<{
		address: Address;
		data: Hex;
		topics: readonly [] | readonly [Hex, ...Hex[]];
	}>,
	logIndex: number,
): KnownOnchainActivity | null {
	try {
		const topics = eventTopics(log.topics);
		if (topics === null) return null;
		const decoded = decodeEventLog({
			abi: DAO_EVENT_ABI,
			data: log.data,
			topics,
			strict: true,
		});
		const contractAddress = log.address.toLowerCase();
		if (decoded.eventName === "StakeAdded")
			return {
				kind: "dao_stake",
				logIndex,
				contractAddress,
				member: decoded.args.member.toLowerCase(),
				amountMinor: decoded.args.amount.toString(),
				totalStakeMinor: decoded.args.totalStake.toString(),
			};
		if (decoded.eventName === "ExitRequested")
			return {
				kind: "dao_exit_requested",
				logIndex,
				contractAddress,
				member: decoded.args.member.toLowerCase(),
				availableAt: decoded.args.availableAt.toString(),
			};
		if (decoded.eventName === "ExitCancelled")
			return {
				kind: "dao_exit_cancelled",
				logIndex,
				contractAddress,
				member: decoded.args.member.toLowerCase(),
			};
		if (decoded.eventName === "StakeWithdrawn")
			return {
				kind: "dao_stake_withdrawn",
				logIndex,
				contractAddress,
				member: decoded.args.member.toLowerCase(),
				amountMinor: decoded.args.amount.toString(),
			};
		if (decoded.eventName === "MinimumStakeUpdated")
			return {
				kind: "dao_minimum_stake_updated",
				logIndex,
				contractAddress,
				previousAmountMinor: decoded.args.previousAmount.toString(),
				newAmountMinor: decoded.args.newAmount.toString(),
			};
		return null;
	} catch {
		return null;
	}
}

function decodeTransferActivity(
	log: Readonly<{
		address: Address;
		data: Hex;
		topics: readonly [] | readonly [Hex, ...Hex[]];
	}>,
	logIndex: number,
	asset: "USDC" | "YD",
): KnownOnchainActivity | null {
	try {
		const topics = eventTopics(log.topics);
		if (topics === null) return null;
		const decoded = decodeEventLog({
			abi: ERC20_EVENT_ABI,
			data: log.data,
			topics,
			strict: true,
		});
		return {
			kind: "token_transfer",
			logIndex,
			contractAddress: log.address.toLowerCase(),
			asset,
			decimals: asset === "USDC" ? 6 : 18,
			from: decoded.args.from.toLowerCase(),
			to: decoded.args.to.toLowerCase(),
			amountMinor: decoded.args.value.toString(),
		};
	} catch {
		return null;
	}
}

/** decodeEventLog 要求首个 topic 必为事件签名；空 topics 日志不是事件，直接忽略。 */
function eventTopics(topics: readonly Hex[]): [Hex, ...Hex[]] | null {
	const [signature, ...parameters] = topics;
	return signature === undefined ? null : [signature, ...parameters];
}

function configuredContracts(): ConfiguredContracts {
	return {
		escrow: optionalAddress(process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS),
		usdc: optionalAddress(process.env.NEXT_PUBLIC_ESCROW_PAYMENT_TOKEN_ADDRESS),
		dao: optionalAddress(process.env.NEXT_PUBLIC_ARBITRATION_DAO_ADDRESS),
		yd: optionalAddress(
			process.env.NEXT_PUBLIC_ARBITRATION_DAO_YD_TOKEN_ADDRESS,
		),
	};
}

function optionalAddress(value: string | undefined): string | null {
	if (value === undefined || !isAddress(value)) return null;
	return getAddress(value).toLowerCase();
}

function chainName(chainId: number): string {
	if (chainId === 1) return "Ethereum";
	if (chainId === 11_155_111) return "Sepolia";
	if (chainId === 31_337) return "AICP Local Anvil";
	return `Chain ${chainId}`;
}
