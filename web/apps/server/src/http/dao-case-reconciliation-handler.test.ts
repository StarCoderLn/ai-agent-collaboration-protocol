import { describe, expect, it, vi } from "vitest";

import { DaoCaseRecoveryError } from "../dao/dao-chain-case-repository";
import { createDaoCaseReconciliationHandler } from "./dao-case-reconciliation-handler";

const commandId = "85000000-0000-4000-8000-000000000001";
const disputeId = "85000000-0000-4000-8000-000000000002";
const alertId = "85000000-0000-4000-8000-000000000003";
const txHash = `0x${"ab".repeat(32)}`;

describe("DAO case reconciliation internal handler", () => {
	it("在解析请求前校验内部认证", async () => {
		const deps = dependencies();
		const handler = createDaoCaseReconciliationHandler({
			...deps,
			internalToken: "internal-secret",
		});
		const response = await handler(request({}, ""));
		expect(response.status).toBe(401);
		expect(deps.retryReverted).not.toHaveBeenCalled();
		expect(deps.resolveFinalReorg).not.toHaveBeenCalled();
	});

	it("拒绝自由文本原因、非法哈希和额外字段", async () => {
		const deps = dependencies();
		const handler = createDaoCaseReconciliationHandler(deps);
		const response = await handler(
			request({
				operation: "retry_reverted_command",
				commandId,
				expectedErrorCode: "DAO_COMMAND_REVERTED",
				expectedTxHash: "0x12",
				resolutionCode: "manual_override",
				note: "直接清掉即可",
			}),
		);
		expect(response.status).toBe(422);
		expect(deps.retryReverted).not.toHaveBeenCalled();
	});

	it("提交回滚交易核对并规范化哈希", async () => {
		const deps = dependencies();
		deps.retryReverted.mockResolvedValue({
			commandId,
			status: "pending",
			nextAttemptNo: 2,
		});
		const response = await createDaoCaseReconciliationHandler(deps)(
			request({
				operation: "retry_reverted_command",
				commandId,
				expectedErrorCode: "DAO_COMMAND_REVERTED",
				expectedTxHash: txHash.toUpperCase().replace("0X", "0x"),
				resolutionCode: "configuration_repaired",
			}),
		);
		expect(response.status).toBe(200);
		expect(deps.retryReverted).toHaveBeenCalledWith({
			operation: "retry_reverted_command",
			commandId,
			expectedErrorCode: "DAO_COMMAND_REVERTED",
			expectedTxHash: txHash,
			resolutionCode: "configuration_repaired",
		});
	});

	it("只接受规范最终裁决恢复告警", async () => {
		const deps = dependencies();
		deps.resolveFinalReorg.mockResolvedValue({
			disputeId,
			alertId,
			status: "resolved",
			restoredJobs: 1,
		});
		const response = await createDaoCaseReconciliationHandler(deps)(
			request({
				operation: "resolve_final_reorg",
				disputeId,
				expectedAlertId: alertId,
				resolutionCode: "canonical_final_restored",
			}),
		);
		expect(response.status).toBe(200);
		expect(deps.resolveFinalReorg).toHaveBeenCalledWith({
			operation: "resolve_final_reorg",
			disputeId,
			expectedAlertId: alertId,
			resolutionCode: "canonical_final_restored",
		});
	});

	it("保留仓储并发冲突的明确错误", async () => {
		const deps = dependencies();
		deps.resolveFinalReorg.mockRejectedValue(
			new DaoCaseRecoveryError(
				409,
				"DAO_CANONICAL_FINAL_MISMATCH",
				"当前确认链未恢复原最终裁决，冻结不能解除",
			),
		);
		const response = await createDaoCaseReconciliationHandler(deps)(
			request({
				operation: "resolve_final_reorg",
				disputeId,
				expectedAlertId: alertId,
				resolutionCode: "canonical_final_restored",
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error_code: "DAO_CANONICAL_FINAL_MISMATCH",
			retryable: false,
		});
	});
});

function dependencies() {
	return {
		internalToken: "internal-secret",
		retryReverted: vi.fn(),
		resolveFinalReorg: vi.fn(),
	};
}

function request(body: unknown, authorization = "Bearer internal-secret") {
	return new Request(
		"http://api.local/api/internal/workers/dao-cases/reconcile",
		{
			method: "POST",
			headers: { authorization, "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);
}
