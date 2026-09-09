import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import {
	confirmDaoEvidence,
	inspectDaoEvidence,
	prepareDaoCaseAction,
} from "./dao-cases";

vi.mock("@/lib/wallet/session-expiry", () => ({
	notifyAuthSessionExpired: vi.fn(),
}));
const evidenceId = "10000000-0000-4000-8000-000000000001";
const disputeId = "10000000-0000-4000-8000-000000000002";
const txHash = `0x${"ab".repeat(32)}`;
const fetchMock = vi.fn<typeof fetch>();

describe("DAO 案件 API 边界", () => {
	beforeEach(() => vi.stubGlobal("fetch", fetchMock));
	afterEach(() => {
		vi.resetAllMocks();
		vi.unstubAllGlobals();
	});

	it("证据确认携带会话及原始证据和交易标识", async () => {
		fetchMock.mockResolvedValue(
			Response.json({ evidenceId, txHash, integrity: "anchored" }),
		);
		await expect(
			confirmDaoEvidence(disputeId, evidenceId, txHash),
		).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining(`/dao/cases/${disputeId}/actions`),
			expect.objectContaining({
				method: "POST",
				credentials: "include",
				body: JSON.stringify({ action: "confirmEvidence", evidenceId, txHash }),
			}),
		);
	});

	it("证据确认 401 通知统一会话过期，同时保留同步失败语义", async () => {
		fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
		await expect(
			confirmDaoEvidence(disputeId, evidenceId, txHash),
		).rejects.toThrow("请保留交易哈希");
		expect(notifyAuthSessionExpired).toHaveBeenCalledOnce();
	});

	it.each([
		{ evidenceId: disputeId, txHash, integrity: "anchored" },
		{ evidenceId, txHash: `0x${"cd".repeat(32)}`, integrity: "anchored" },
		{ evidenceId, txHash, integrity: "pending" },
	])("拒绝其他证据、其他交易或未锚定响应 %j", async (body) => {
		fetchMock.mockResolvedValue(Response.json(body));
		await expect(
			confirmDaoEvidence(disputeId, evidenceId, txHash),
		).rejects.toThrow();
	});

	it("哈希大小写变化不改变交易身份", async () => {
		fetchMock.mockResolvedValue(
			Response.json({ evidenceId, txHash, integrity: "anchored" }),
		);
		await expect(
			confirmDaoEvidence(
				disputeId,
				evidenceId.toUpperCase(),
				`0x${txHash.slice(2).toUpperCase()}`,
			),
		).resolves.toBeUndefined();
	});

	it("非认证服务错误不清除会话", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
		await expect(
			confirmDaoEvidence(disputeId, evidenceId, txHash),
		).rejects.toThrow("同步尚未完成");
		expect(notifyAuthSessionExpired).not.toHaveBeenCalled();
	});

	it("证据状态核验绑定原证据和哈希，只有服务端明确返回重签资格", async () => {
		fetchMock.mockResolvedValue(
			Response.json({
				evidenceId,
				txHash,
				status: "reverted",
				retryAllowed: true,
			}),
		);
		await expect(
			inspectDaoEvidence(disputeId, evidenceId, txHash),
		).resolves.toEqual({
			evidenceId,
			txHash,
			status: "reverted",
			retryAllowed: true,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining(`/dao/cases/${disputeId}/actions`),
			expect.objectContaining({
				body: JSON.stringify({ action: "inspectEvidence", evidenceId, txHash }),
			}),
		);
	});

	it.each([
		{ evidenceId: disputeId, txHash, status: "reverted", retryAllowed: true },
		{
			evidenceId,
			txHash: `0x${"cd".repeat(32)}`,
			status: "reverted",
			retryAllowed: true,
		},
		{ evidenceId, txHash, status: "pending", retryAllowed: true },
	])("拒绝错配或自行授予重签资格的证据状态 %j", async (body) => {
		fetchMock.mockResolvedValue(Response.json(body));
		await expect(
			inspectDaoEvidence(disputeId, evidenceId, txHash),
		).rejects.toThrow();
	});

	it("准备动作 401 继续通知会话过期", async () => {
		fetchMock.mockResolvedValue(
			Response.json({ message: "登录已过期" }, { status: 401 }),
		);
		await expect(
			prepareDaoCaseAction(disputeId, { action: "appeal" }),
		).rejects.toThrow("登录已过期");
		expect(notifyAuthSessionExpired).toHaveBeenCalledOnce();
	});

	it("准备动作拒绝不符合白名单契约的交易", async () => {
		fetchMock.mockResolvedValue(
			Response.json({ chainId: "31337", action: "transfer" }),
		);
		await expect(
			prepareDaoCaseAction(disputeId, { action: "appeal" }),
		).rejects.toThrow();
	});
});
