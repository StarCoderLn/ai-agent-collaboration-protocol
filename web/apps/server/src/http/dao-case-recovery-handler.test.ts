import { describe, expect, it, vi } from "vitest";

import { DaoCaseRecoveryError } from "../dao/dao-chain-case-repository";
import { createDaoCaseRecoveryHandler } from "./dao-case-recovery-handler";

const commandId = "85000000-0000-4000-8000-000000000001";

describe("DAO case recovery internal handler", () => {
	it("内部认证未配置时拒绝启用恢复入口", async () => {
		const retry = vi.fn();
		const handler = createDaoCaseRecoveryHandler({ internalToken: "", retry });
		const response = await handler(request({}));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error_code: "INTERNAL_AUTH_NOT_CONFIGURED",
			retryable: true,
		});
		expect(retry).not.toHaveBeenCalled();
	});

	it("在解析请求前校验内部认证", async () => {
		const retry = vi.fn();
		const handler = createDaoCaseRecoveryHandler({
			internalToken: "internal-secret",
			retry,
		});
		const response = await handler(request({}, ""));
		expect(response.status).toBe(401);
		expect(retry).not.toHaveBeenCalled();
	});

	it("拒绝缺少核对理由或旧错误码的恢复请求", async () => {
		const retry = vi.fn();
		const handler = createDaoCaseRecoveryHandler({
			internalToken: "internal-secret",
			retry,
		});
		const response = await handler(
			request({
				commandId,
				expectedErrorCode: "bad",
				resolutionCode: "arbitrary_text",
			}),
		);
		expect(response.status).toBe(422);
		expect(retry).not.toHaveBeenCalled();
	});

	it("返回经过仓储状态复核的重试结果", async () => {
		const retry = vi.fn().mockResolvedValue({
			commandId,
			disputeId: "dispute-1",
			commandKey: "open",
			status: "pending",
		});
		const handler = createDaoCaseRecoveryHandler({
			internalToken: "internal-secret",
			retry,
		});
		const response = await handler(
			request({
				commandId,
				expectedErrorCode: "DAO_PREPARE_FAILED",
				resolutionCode: "rpc_recovered",
			}),
		);
		expect(response.status).toBe(200);
		expect(retry).toHaveBeenCalledWith({
			commandId,
			expectedErrorCode: "DAO_PREPARE_FAILED",
			resolutionCode: "rpc_recovered",
		});
		expect(await response.json()).toMatchObject({
			commandId,
			commandKey: "open",
			status: "pending",
		});
	});

	it("保留已签名命令的明确拒绝语义", async () => {
		const retry = vi
			.fn()
			.mockRejectedValue(
				new DaoCaseRecoveryError(
					409,
					"DAO_SIGNED_COMMAND_RETRY_FORBIDDEN",
					"已签名命令必须保留原交易并核对回执",
				),
			);
		const handler = createDaoCaseRecoveryHandler({
			internalToken: "internal-secret",
			retry,
		});
		const response = await handler(
			request({
				commandId,
				expectedErrorCode: "DAO_COMMAND_REVERTED",
				resolutionCode: "configuration_repaired",
			}),
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toMatchObject({
			error_code: "DAO_SIGNED_COMMAND_RETRY_FORBIDDEN",
			retryable: false,
		});
	});
});

function request(body: unknown, authorization = "Bearer internal-secret") {
	return new Request("http://api.local/api/internal/workers/dao-cases/retry", {
		method: "POST",
		headers:
			authorization === undefined
				? { "content-type": "application/json" }
				: {
						authorization,
						"content-type": "application/json",
					},
		body: JSON.stringify(body),
	});
}
