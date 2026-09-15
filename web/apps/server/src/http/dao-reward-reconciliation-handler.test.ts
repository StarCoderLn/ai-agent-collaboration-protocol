import { describe, expect, it, vi } from "vitest";

import { DaoRewardRecoveryError } from "../dao/dao-reward-recovery";
import { createDaoRewardReconciliationHandler } from "./dao-reward-reconciliation-handler";

const oldHash = `0x${"ab".repeat(32)}`;

describe("DAO reward reconciliation internal handler", () => {
	it("在解析请求前校验内部认证", async () => {
		const deps = dependencies();
		const response = await createDaoRewardReconciliationHandler(deps)(
			request({}, ""),
		);
		expect(response.status).toBe(401);
		expect(deps.resolveCursorReorg).not.toHaveBeenCalled();
	});

	it("拒绝数字溢出写法、自由文本原因和额外字段", async () => {
		const deps = dependencies();
		const response = await createDaoRewardReconciliationHandler(deps)(
			request({
				operation: "resolve_cursor_reorg",
				expectedNextBlock: 2,
				expectedLastBlockHash: oldHash,
				resolutionCode: "manual_override",
				note: "直接回退游标",
			}),
		);
		expect(response.status).toBe(422);
		expect(deps.resolveCursorReorg).not.toHaveBeenCalled();
	});

	it("规范化游标哈希并提交固定恢复原因", async () => {
		const deps = dependencies();
		deps.resolveCursorReorg.mockResolvedValue({
			status: "resolved",
			nextBlock: "2",
		});
		const upperHash = oldHash.toUpperCase().replace("0X", "0x");
		const response = await createDaoRewardReconciliationHandler(deps)(
			request({
				operation: "resolve_cursor_reorg",
				expectedNextBlock: "2",
				expectedLastBlockHash: upperHash,
				resolutionCode: "canonical_history_restored",
			}),
		);
		expect(response.status).toBe(200);
		expect(deps.resolveCursorReorg).toHaveBeenCalledWith({
			operation: "resolve_cursor_reorg",
			expectedNextBlock: "2",
			expectedLastBlockHash: oldHash,
			resolutionCode: "canonical_history_restored",
		});
	});

	it("保留确认链历史不一致的明确冲突", async () => {
		const deps = dependencies();
		deps.resolveCursorReorg.mockRejectedValue(
			new DaoRewardRecoveryError(
				409,
				"REWARD_CANONICAL_HISTORY_MISMATCH",
				"当前确认链奖励历史与原投影不一致，继续保持冻结",
			),
		);
		const response = await createDaoRewardReconciliationHandler(deps)(
			request({
				operation: "resolve_cursor_reorg",
				expectedNextBlock: "2",
				expectedLastBlockHash: oldHash,
				resolutionCode: "canonical_history_restored",
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error_code: "REWARD_CANONICAL_HISTORY_MISMATCH",
			retryable: false,
		});
	});
});

function dependencies() {
	return { internalToken: "internal-secret", resolveCursorReorg: vi.fn() };
}

function request(body: unknown, authorization = "Bearer internal-secret") {
	return new Request(
		"http://api.local/api/internal/workers/dao-rewards/reconcile",
		{
			method: "POST",
			headers: { authorization, "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}
