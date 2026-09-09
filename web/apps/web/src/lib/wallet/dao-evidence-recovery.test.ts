import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDaoEvidenceRecovery } from "./dao-evidence-recovery";

const scope = {
	walletAddress: `0x${"ab".repeat(20)}`,
	chainId: "31337",
	contractAddress: `0x${"cd".repeat(20)}`,
	disputeId: "10000000-0000-4000-8000-000000000001",
};
const record = {
	evidenceId: "10000000-0000-4000-8000-000000000002",
	txHash: `0x${"44".repeat(32)}`,
};
beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("证据交易恢复日志", () => {
	it("两个标签页对同一证据广播不同哈希时保留全部尝试，相同记录去重，成功清理不影响其他证据", () => {
		const first = createDaoEvidenceRecovery(scope);
		const second = createDaoEvidenceRecovery(scope);
		first.read();
		second.read();
		const retry = { ...record, txHash: `0x${"55".repeat(32)}` };
		const other = {
			...record,
			evidenceId: "10000000-0000-4000-8000-000000000003",
		};
		first.remember(record);
		second.remember(retry);
		second.remember(retry);
		second.remember(other);
		const recovered = createDaoEvidenceRecovery(scope);
		expect(recovered.read().records).toHaveLength(3);
		expect(recovered.read().records).toEqual(
			expect.arrayContaining([record, retry, other]),
		);
		recovered.forget(record.evidenceId);
		expect(createDaoEvidenceRecovery(scope).read().records).toEqual([other]);
	});
	it("两个标签页的旧内存快照写入不同证据不会互相覆盖", () => {
		const first = createDaoEvidenceRecovery(scope);
		const second = createDaoEvidenceRecovery(scope);
		first.read();
		second.read();
		const other = {
			...record,
			evidenceId: "10000000-0000-4000-8000-000000000003",
		};
		first.remember(record);
		second.remember(other);
		expect(createDaoEvidenceRecovery(scope).read().records).toEqual(
			expect.arrayContaining([record, other]),
		);
		first.forget(record.evidenceId);
		expect(createDaoEvidenceRecovery(scope).read().records).toEqual([other]);
	});
	it("地址大小写归一化，持久数据只含证据标识与哈希，清理一条不影响其他证据", () => {
		const first = createDaoEvidenceRecovery(scope);
		first.remember(record);
		const other = {
			...record,
			evidenceId: "10000000-0000-4000-8000-000000000003",
		};
		first.remember(other);
		const key = localStorage.key(0);
		if (key === null) throw new Error("缺少持久记录");
		expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(record);
		expect(localStorage.length).toBe(2);
		const recovered = createDaoEvidenceRecovery({
			...scope,
			walletAddress: `0x${"AB".repeat(20)}`,
		});
		expect(recovered.read().records).toEqual([record, other]);
		recovered.forget(record.evidenceId);
		expect(createDaoEvidenceRecovery(scope).read().records).toEqual([other]);
	});
	it.each([
		{ record: { ...record, txHash: "not-a-hash" } },
		{ record: { ...record, evidenceId: "not-an-id" } },
		{ record: { ...record, body: "不应进入恢复记录的正文" } },
		{
			record: { ...record, evidenceId: "10000000-0000-4000-8000-000000000009" },
		},
	])("拒绝不可信形状或与存储键不匹配的证据 %j", ({ record: badRecord }) => {
		createDaoEvidenceRecovery(scope).remember(record);
		const key = localStorage.key(0);
		if (key === null) throw new Error("缺少持久记录");
		localStorage.setItem(key, JSON.stringify(badRecord));
		expect(createDaoEvidenceRecovery(scope).read()).toEqual({
			records: [],
			issue: "invalid",
		});
	});
	it("读取和写入均被浏览器拒绝时，内存哈希仍可恢复并明确报告存储失败", () => {
		createDaoEvidenceRecovery(scope).remember(record);
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("denied");
		});
		const recovery = createDaoEvidenceRecovery(scope);
		expect(recovery.read()).toEqual({ records: [], issue: "unavailable" });
		expect(recovery.remember(record)).toEqual({
			records: [record],
			issue: "unavailable",
		});
		expect(recovery.read().records).toEqual([record]);
	});
});
