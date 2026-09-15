import { describe, expect, it, vi } from "vitest";
import {
	type DaoCaseRpcProvider,
	RpcDaoCaseChainClient,
} from "./dao-case-chain-client";
import {
	daoCaseInterface,
	daoCaseKey,
	daoEvidenceKey,
} from "./dao-case-contract";

const address = `0x${"11".repeat(20)}`;
const actor = `0x${"22".repeat(20)}`;
const hash = `0x${"33".repeat(32)}`;
const otherHash = `0x${"44".repeat(32)}`;
const caseKey = daoCaseKey("10000000-0000-4000-8000-000000000001");
const evidenceKey = daoEvidenceKey("10000000-0000-4000-8000-000000000002");

/** 所有读方法都走真实 ABI 编解码，覆盖错误网络、重组和冒认他人证据等信任边界。 */
describe("链上案件 RPC 校验", () => {
	it("在同一确认区块读取状态、小组与真实投票，零 requestId 不被误判为已抽签", async () => {
		const provider = fakeProvider();
		const call = vi.spyOn(provider, "call");
		const result = await new RpcDaoCaseChainClient(
			provider,
			31337n,
			address,
			2,
		).read(caseKey);
		expect(result).toMatchObject({
			status: "voting",
			round: 1,
			voteCount: 1,
			voters: [actor],
			blockNumber: "99",
			requestId: "0",
		});
		expect(call.mock.calls.every(([request]) => request.blockTag === 99)).toBe(
			true,
		);
	});

	it("只在新版恢复状态读取公开兜底与全案硬期限", async () => {
		const provider = fakeProvider();
		const baseCall = provider.call.bind(provider);
		provider.call = async (request) => {
			const parsed = daoCaseInterface.parseTransaction({ data: request.data });
			if (parsed?.name === "caseOf")
				return daoCaseInterface.encodeFunctionResult("caseOf", [
					[hash, hash, 9, 2, 900, 1200, 0, 0, false, actor, [10, 20, 1, 1]],
				]);
			if (parsed?.name === "timeoutFallbackBps")
				return daoCaseInterface.encodeFunctionResult("timeoutFallbackBps", [0]);
			if (parsed?.name === "recoveryEligibleAt")
				return daoCaseInterface.encodeFunctionResult(
					"recoveryEligibleAt",
					[1100],
				);
			return baseCall(request);
		};
		await expect(
			new RpcDaoCaseChainClient(provider, 31337n, address, 2).read(caseKey),
		).resolves.toMatchObject({
			status: "recovery",
			timeoutFallbackBasisPoints: 0,
			recoveryEligibleAt: "1100",
		});
	});

	it("不接受错误链或读取期间的链重组", async () => {
		const wrongNetwork = fakeProvider();
		wrongNetwork.getNetwork = async () => ({ chainId: 1n });
		await expect(
			new RpcDaoCaseChainClient(wrongNetwork, 31337n, address, 2).read(caseKey),
		).rejects.toThrow("DAO_CASE_CHAIN_MISMATCH");
		const reorg = fakeProvider();
		let reads = 0;
		reorg.getBlock = async (number) => ({
			number,
			timestamp: 1000,
			hash: reads++ === 0 ? hash : otherHash,
		});
		await expect(
			new RpcDaoCaseChainClient(reorg, 31337n, address, 2).read(caseKey),
		).rejects.toThrow("DAO_CASE_BLOCK_REORGED");
	});

	it("证据确认必须匹配案件、证据 ID、提交者和规范成功回执", async () => {
		const provider = fakeProvider();
		const event = daoCaseInterface.getEvent("EvidenceAnchored");
		if (event === null) throw new Error("TEST_EVENT_MISSING");
		const log = daoCaseInterface.encodeEventLog(event, [
			caseKey,
			evidenceKey,
			actor,
			otherHash,
			hash,
		]);
		provider.getTransactionReceipt = async () => ({
			blockNumber: 90,
			blockHash: hash,
			status: 1,
			to: address,
			from: actor,
			logs: [{ address, ...log }],
		});
		const client = new RpcDaoCaseChainClient(provider, 31337n, address, 2);
		await expect(
			client.verifyEvidence(hash, caseKey, evidenceKey, actor),
		).resolves.toBe(otherHash);
		await expect(
			client.verifyEvidence(hash, caseKey, evidenceKey, address),
		).rejects.toThrow("DAO_EVIDENCE_RECEIPT_INVALID");
		await expect(
			client.verifyEvidence(hash, caseKey, hash, actor),
		).rejects.toThrow("DAO_EVIDENCE_RECEIPT_INVALID");
		provider.getTransactionReceipt = async () => ({
			blockNumber: 100,
			blockHash: hash,
			status: 1,
			to: address,
			from: actor,
			logs: [{ address, ...log }],
		});
		await expect(
			client.verifyEvidence(hash, caseKey, evidenceKey, actor),
		).rejects.toThrow("DAO_EVIDENCE_CONFIRMATIONS_PENDING");
	});

	it("接受 MetaMask 委托钱包外层执行中由案件合约发出的真实证据事件", async () => {
		const provider = fakeProvider();
		const event = daoCaseInterface.getEvent("EvidenceAnchored");
		if (event === null) throw new Error("TEST_EVENT_MISSING");
		const log = daoCaseInterface.encodeEventLog(event, [
			caseKey,
			evidenceKey,
			actor,
			otherHash,
			hash,
		]);
		provider.getTransactionReceipt = async () => ({
			blockNumber: 90,
			blockHash: hash,
			status: 1,
			to: actor,
			from: actor,
			logs: [{ address, ...log }],
		});
		provider.getTransaction = async () => ({
			to: actor,
			from: actor,
			data: "0xcef6d209",
		});
		const client = new RpcDaoCaseChainClient(provider, 31337n, address, 2);

		await expect(
			client.inspectEvidenceTransaction(
				hash,
				caseKey,
				evidenceKey,
				actor,
				otherHash,
			),
		).resolves.toEqual({ status: "confirmed", contentHash: otherHash });

		provider.getTransactionReceipt = async () => ({
			blockNumber: 90,
			blockHash: hash,
			status: 0,
			to: actor,
			from: actor,
			logs: [],
		});
		await expect(
			client.inspectEvidenceTransaction(
				hash,
				caseKey,
				evidenceKey,
				actor,
				otherHash,
			),
		).resolves.toEqual({
			status: "invalid",
			code: "DAO_EVIDENCE_RECEIPT_INVALID",
		});
	});

	it("只有规范确认的原发送者回滚交易允许重签，未知和孤块继续等待", async () => {
		const provider = fakeProvider();
		const client = new RpcDaoCaseChainClient(provider, 31337n, address, 2);
		await expect(
			client.inspectEvidenceTransaction(hash, caseKey, evidenceKey, actor),
		).resolves.toEqual({ status: "pending" });
		provider.getTransactionReceipt = async () => ({
			blockNumber: 90,
			blockHash: hash,
			status: 0,
			to: address,
			from: actor,
			logs: [],
		});
		await expect(
			client.inspectEvidenceTransaction(
				hash,
				caseKey,
				evidenceKey,
				actor,
				otherHash,
			),
		).resolves.toEqual({ status: "reverted" });
		provider.getTransaction = async () => ({
			to: address,
			from: actor,
			data: daoCaseInterface.encodeFunctionData("submitEvidence", [
				caseKey,
				hash,
				otherHash,
			]),
		});
		await expect(
			client.inspectEvidenceTransaction(
				hash,
				caseKey,
				evidenceKey,
				actor,
				otherHash,
			),
		).resolves.toEqual({
			status: "invalid",
			code: "DAO_EVIDENCE_RECEIPT_INVALID",
		});
		provider.getTransaction = async () => ({
			to: address,
			from: actor,
			data: daoCaseInterface.encodeFunctionData("submitEvidence", [
				caseKey,
				evidenceKey,
				otherHash,
			]),
		});
		provider.getTransactionReceipt = async () => ({
			blockNumber: 90,
			blockHash: hash,
			status: 0,
			to: address,
			from: address,
			logs: [],
		});
		await expect(
			client.inspectEvidenceTransaction(hash, caseKey, evidenceKey, actor),
		).resolves.toEqual({
			status: "invalid",
			code: "DAO_EVIDENCE_RECEIPT_INVALID",
		});
		provider.getTransactionReceipt = async () => ({
			blockNumber: 90,
			blockHash: otherHash,
			status: 0,
			to: address,
			from: actor,
			logs: [],
		});
		await expect(
			client.inspectEvidenceTransaction(hash, caseKey, evidenceKey, actor),
		).resolves.toEqual({ status: "pending" });
	});
});

/** 测试只模拟外部节点，保留正式客户端的 ABI、区块固定和身份核验代码。 */
function fakeProvider(): DaoCaseRpcProvider {
	return {
		getNetwork: async () => ({ chainId: 31337n }),
		getBlockNumber: async () => 100,
		getBlock: async (number) => ({ number, timestamp: 1000, hash }),
		getTransactionReceipt: async () => null,
		getTransaction: async () => ({
			to: address,
			from: actor,
			data: daoCaseInterface.encodeFunctionData("submitEvidence", [
				caseKey,
				evidenceKey,
				otherHash,
			]),
		}),
		call: async (request) => {
			const parsed = daoCaseInterface.parseTransaction({ data: request.data });
			if (parsed?.name === "caseOf")
				return daoCaseInterface.encodeFunctionResult("caseOf", [
					[hash, hash, 5, 1, 900, 1200, 0, 0, false, actor, [10, 20, 1, 1]],
				]);
			if (parsed?.name === "roundOf")
				return daoCaseInterface.encodeFunctionResult("roundOf", [
					[0, 0, false, false, hash, [actor], [actor], 1],
				]);
			if (parsed?.name === "votes")
				return daoCaseInterface.encodeFunctionResult("votes", [
					true,
					5000,
					hash,
				]);
			throw new Error("UNEXPECTED_TEST_RPC_CALL");
		},
	};
}
