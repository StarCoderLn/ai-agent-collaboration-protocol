import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ChainArbitration,
	DaoCaseAction,
	PreparedDaoCaseAction,
} from "@/lib/api/dao-cases";
import {
	daoCaseWalletErrorMessage,
	executeDaoCaseAction,
} from "./dao-case-flow";

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	prepare: vi.fn(),
	confirm: vi.fn(),
	connection: vi.fn(),
	nonce: vi.fn(),
	read: vi.fn(),
	send: vi.fn(),
	switch: vi.fn(),
	receipt: vi.fn(),
	write: vi.fn(),
}));
vi.mock("@/lib/api/dao-cases", () => ({
	prepareDaoCaseAction: mocks.prepare,
	confirmDaoEvidence: mocks.confirm,
}));
vi.mock("wagmi/actions", () => ({
	connect: mocks.connect,
	getConnection: mocks.connection,
	getTransactionCount: mocks.nonce,
	readContract: mocks.read,
	sendTransaction: mocks.send,
	switchChain: mocks.switch,
	waitForTransactionReceipt: mocks.receipt,
	writeContract: mocks.write,
}));

const wallet = `0x${"11".repeat(20)}`;
const contract = `0x${"22".repeat(20)}`;
const token = `0x${"33".repeat(20)}`;
const txHash = `0x${"ab".repeat(32)}`;
const approvalHash = `0x${"cd".repeat(32)}`;
const evidenceId = "10000000-0000-4000-8000-000000000001";
const prepared: PreparedDaoCaseAction = {
	chainId: "31337",
	to: contract,
	data: "0x1234",
	value: "0",
	action: "appeal",
	approvalAmountMinor: "21",
	paymentTokenAddress: token,
	appealBondMinor: "20",
	appealFeeMinor: "1",
	bondPolicy: 1,
};
const caseInfo: ChainArbitration = {
	chainId: "31337",
	contractAddress: contract,
	caseKey: txHash,
	status: "appeal_window",
	lastErrorCode: null,
	viewerIsParty: true,
	snapshot: {
		status: "appeal_window",
		round: 1,
		evidenceRoot: txHash,
		evidenceDeadline: "10",
		deadline: "100",
		releaseBasisPoints: 5000,
		appealBondMinor: "20",
		appealFeeMinor: "1",
		rewardPerVoteMinor: "10",
		bondPolicy: 1,
		panel: [],
		firstPanel: [],
		voteCount: 0,
		voters: [],
		requestId: "1",
		blockNumber: "10",
		blockTimestamp: "20",
	},
};

describe("DAO 钱包操作边界", () => {
	beforeEach(() => {
		mocks.connect.mockResolvedValue({ accounts: [wallet] });
		mocks.prepare.mockResolvedValue(prepared);
		mocks.confirm.mockResolvedValue(undefined);
		mocks.connection.mockReturnValue({
			status: "connected",
			address: wallet,
			chainId: 31337,
			connector: {},
		});
		mocks.nonce.mockResolvedValue(7);
		mocks.read.mockResolvedValue(BigInt(0));
		mocks.send.mockResolvedValue(txHash);
		mocks.write.mockResolvedValue(approvalHash);
		mocks.receipt.mockResolvedValue({ status: "success" });
	});
	afterEach(() => vi.resetAllMocks());

	it("只授权展示的保证金加服务费，成功回执后才发申诉", async () => {
		const request = input();
		await expect(executeDaoCaseAction(request)).resolves.toBe(txHash);
		expect(mocks.write).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				address: token,
				functionName: "approve",
				args: [contract, BigInt(21)],
				gas: BigInt(1_000_000),
				nonce: 7,
			}),
		);
		expect(mocks.send).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				to: contract,
				account: wallet,
				value: BigInt(0),
				data: "0x1234",
				gas: BigInt(1_000_000),
				nonce: 7,
			}),
		);
		expect(request.onBroadcast).toHaveBeenCalledExactlyOnceWith(txHash);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.receipt).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				hash: txHash,
				pollingInterval: 1_000,
				timeout: 90_000,
			}),
		);
		expect(mocks.nonce).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ blockTag: "pending" }),
		);
	});

	it("既有额度足够时不重复授权", async () => {
		mocks.read.mockResolvedValue(BigInt(21));
		await executeDaoCaseAction(input());
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it.each([{ to: token }, { chainId: "11155111" }, { action: "vote" }])(
		"案件合约/链/动作变化不请求签名 %j",
		async (change) => {
			mocks.prepare.mockResolvedValue({ ...prepared, ...change });
			await expect(executeDaoCaseAction(input())).rejects.toThrow(
				"案件合约配置已变化",
			);
			expect(mocks.write).not.toHaveBeenCalled();
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ appealBondMinor: "30" },
		{ appealFeeMinor: "2" },
		{ bondPolicy: 2 },
		{ approvalAmountMinor: "22" },
	])("费用或条款变化不授权 %j", async (change) => {
		mocks.prepare.mockResolvedValue({ ...prepared, ...change });
		await expect(executeDaoCaseAction(input())).rejects.toThrow();
		expect(mocks.write).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("缺少展示条款不授权", async () => {
		await expect(
			executeDaoCaseAction({
				...input(),
				caseInfo: { ...caseInfo, snapshot: null },
			}),
		).rejects.toThrow("申诉条款已变化");
		expect(mocks.write).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it.each(["rejected", "reverted"])("授权 %s 后不发送申诉", async (failure) => {
		if (failure === "rejected")
			mocks.write.mockRejectedValue(new Error("用户拒绝"));
		else mocks.receipt.mockResolvedValue({ status: "reverted" });
		await expect(executeDaoCaseAction(input())).rejects.toThrow();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("拒绝切链后不发送任何交易", async () => {
		mocks.connection.mockReturnValue({
			status: "connected",
			address: wallet,
			chainId: 1,
			connector: {},
		});
		mocks.switch.mockRejectedValue(new Error("用户拒绝切链"));
		await expect(executeDaoCaseAction(input())).rejects.toThrow("用户拒绝切链");
		expect(mocks.write).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("当前钱包与登录身份不同不请求签名", async () => {
		mocks.connection.mockReturnValue({
			status: "connected",
			address: token,
			chainId: 31337,
		});
		await expect(executeDaoCaseAction(input())).rejects.toThrow("相同的钱包");
		expect(mocks.write).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("刷新后在用户案件操作中恢复同一钱包连接", async () => {
		mocks.prepare.mockResolvedValue({ ...prepared, action: "evidence" });
		mocks.connection
			.mockReturnValueOnce({ status: "disconnected" })
			.mockReturnValue({
				status: "connected",
				address: wallet,
				chainId: 31337,
				connector: {},
			});

		await expect(
			executeDaoCaseAction(input({ action: "evidence", evidenceId })),
		).resolves.toBe(txHash);
		expect(mocks.connect).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ chainId: 31337 }),
		);
		expect(mocks.send).toHaveBeenCalledOnce();
	});

	it("切链期间切换身份后不请求授权或发送案件交易", async () => {
		mocks.connection.mockReturnValue({
			status: "connected",
			address: wallet,
			chainId: 1,
			connector: {},
		});
		mocks.switch.mockImplementation(async () => {
			mocks.connection.mockReturnValue({
				status: "connected",
				address: token,
				chainId: 31337,
			});
		});
		await expect(executeDaoCaseAction(input())).rejects.toThrow();
		expect(mocks.write).not.toHaveBeenCalled();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("读取 pending nonce 期间切换身份不发送案件交易", async () => {
		mocks.prepare.mockResolvedValue({ ...prepared, action: "evidence" });
		mocks.nonce.mockImplementation(async () => {
			mocks.connection.mockReturnValue({
				status: "connected",
				address: token,
				chainId: 31337,
			});
			return 7;
		});
		await expect(
			executeDaoCaseAction(input({ action: "evidence", evidenceId })),
		).rejects.toThrow();
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it("授权期间切换身份后不发送案件交易", async () => {
		mocks.receipt.mockImplementation(async () => {
			mocks.connection.mockReturnValue({
				status: "connected",
				address: token,
				chainId: 31337,
			});
			return { status: "success" };
		});
		await expect(executeDaoCaseAction(input())).rejects.toThrow("账户已切换");
		expect(mocks.send).not.toHaveBeenCalled();
	});

	it.each(["disconnected", "wrong-chain"])(
		"等待期间 %s 不发送案件交易",
		async (change) => {
			mocks.prepare.mockResolvedValue({ ...prepared, action: "evidence" });
			mocks.nonce.mockImplementation(async () => {
				mocks.connection.mockReturnValue({
					status: change === "disconnected" ? "disconnected" : "connected",
					address: wallet,
					chainId: 1,
				});
				return 7;
			});
			await expect(
				executeDaoCaseAction(input({ action: "evidence", evidenceId })),
			).rejects.toThrow("网络已变化");
			expect(mocks.send).not.toHaveBeenCalled();
		},
	);

	it("证据失败回执不触发服务端锚定确认，已广播哈希仍交给页面", async () => {
		mocks.prepare.mockResolvedValue({ ...prepared, action: "evidence" });
		mocks.receipt.mockResolvedValue({ status: "reverted" });
		const request = input({ action: "evidence", evidenceId });
		await expect(executeDaoCaseAction(request)).rejects.toThrow("未执行成功");
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(request.onBroadcast).toHaveBeenCalledExactlyOnceWith(txHash);
	});

	it("成功证据回执只确认原始证据和广播交易", async () => {
		mocks.prepare.mockResolvedValue({ ...prepared, action: "evidence" });
		const request = input({ action: "evidence", evidenceId });
		await expect(executeDaoCaseAction(request)).resolves.toBe(txHash);
		expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(
			request.disputeId,
			evidenceId,
			txHash,
		);
		expect(mocks.write).not.toHaveBeenCalled();
	});

	it("服务端确认失败保留已广播哈希且不重发交易", async () => {
		mocks.prepare.mockResolvedValue({ ...prepared, action: "evidence" });
		mocks.confirm.mockRejectedValue(new Error("同步失败"));
		const request = input({ action: "evidence", evidenceId });
		await expect(executeDaoCaseAction(request)).rejects.toThrow("同步失败");
		expect(request.onBroadcast).toHaveBeenCalledExactlyOnceWith(txHash);
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it("回执等待超时仍保留原始广播哈希，不发起第二次交易", async () => {
		mocks.prepare.mockResolvedValue({ ...prepared, action: "evidence" });
		mocks.receipt.mockRejectedValue(new Error("回执等待超时"));
		const request = input({ action: "evidence", evidenceId });
		await expect(executeDaoCaseAction(request)).rejects.toThrow("回执等待超时");
		expect(request.onBroadcast).toHaveBeenCalledExactlyOnceWith(txHash);
		expect(mocks.confirm).not.toHaveBeenCalled();
		expect(mocks.send).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			new Error(
				"transaction gas limit too high (cap: 16777216, tx: 21000000) Request Arguments: 0xdeadbeef",
			),
			false,
			"钱包给出的 Gas 上限异常，交易尚未发送。请刷新页面后重试。",
		],
		[
			Object.assign(new Error("User rejected the request. Details: calldata"), {
				code: 4001,
			}),
			false,
			"你已取消钱包操作，交易尚未发送。",
		],
		[
			new Error("execution reverted: private rpc payload 0xdeadbeef"),
			false,
			"链上执行失败，资金和案件状态未改变。请刷新案件后重试。",
		],
		[
			new Error("unknown rpc https://secret.example 0xdeadbeef"),
			false,
			"操作未完成，请刷新案件后重试。",
		],
		[
			new Error("unknown rpc https://secret.example 0xdeadbeef"),
			true,
			"The operation could not be completed. Refresh the case and try again.",
		],
	] as const)("钱包异常映射为安全提示 %#", (error, en, expected) => {
		const message = daoCaseWalletErrorMessage(error, en);
		expect(message).toBe(expected);
		expect(message).not.toContain("0xdeadbeef");
		expect(message).not.toContain("secret.example");
	});
});

function input(action: DaoCaseAction = { action: "appeal" }) {
	return {
		disputeId: "10000000-0000-4000-8000-000000000002",
		walletAddress: wallet,
		caseInfo,
		action,
		onProgress: vi.fn(),
		onBroadcast: vi.fn(),
	};
}
