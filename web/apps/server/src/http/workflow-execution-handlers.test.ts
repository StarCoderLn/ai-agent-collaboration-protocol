import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import {
	createInternalWorkflowExecutionHandlers,
	createPublisherWorkflowExecutionHandlers,
} from "./workflow-execution-handlers";

const TASK_ID = "72000000-0000-4000-8000-000000000001";
const NODE_ID = "72000000-0000-4000-8000-000000000002";
const RESULT_ID = "72000000-0000-4000-8000-000000000003";
const ACTOR_ID = `0x${"44".repeat(20)}`;
const CONTEXT = { params: Promise.resolve({ id: TASK_ID, nodeId: NODE_ID }) };

describe("workflow execution handlers", () => {
	it("只允许内部服务上报，并把任务、节点、幂等键与请求指纹完整传给事务仓储", async () => {
		const reportStatus = vi.fn(async () => ({
			statusCode: 200,
			body: {
				taskId: TASK_ID,
				workflowNodeId: NODE_ID,
				nodeStatus: "executing",
			},
		}));
		const handlers = createInternalWorkflowExecutionHandlers({
			internalToken: "internal-secret",
			reportStatus,
			submitResults: vi.fn(),
		});
		const payload = JSON.stringify({ assignmentId: RESULT_ID, progress: 25 });

		const denied = await handlers.reportStatus(
			new Request("http://api.local", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: payload,
			}),
			CONTEXT,
		);
		expect(denied.status).toBe(401);
		expect(reportStatus).not.toHaveBeenCalled();

		const accepted = await handlers.reportStatus(
			new Request("http://api.local", {
				method: "POST",
				headers: {
					authorization: "Bearer internal-secret",
					"content-type": "application/json",
					"idempotency-key": "workflow-progress-1",
				},
				body: payload,
			}),
			CONTEXT,
		);
		expect(accepted.status).toBe(200);
		expect(reportStatus).toHaveBeenCalledWith(
			TASK_ID,
			NODE_ID,
			JSON.parse(payload),
			"workflow-progress-1",
			expect.stringMatching(/^[0-9a-f]{64}$/),
		);
	});

	it("在进入仓储前拒绝非法节点标识和非法 JSON，避免产生无法归属的执行事实", async () => {
		const submitResults = vi.fn();
		const handlers = createInternalWorkflowExecutionHandlers({
			internalToken: "internal-secret",
			reportStatus: vi.fn(),
			submitResults,
		});
		const headers = {
			authorization: "Bearer internal-secret",
			"content-type": "application/json",
		};

		const invalidTarget = await handlers.submitResults(
			new Request("http://api.local", {
				method: "POST",
				headers,
				body: "{}",
			}),
			{ params: Promise.resolve({ id: TASK_ID, nodeId: "not-a-node-id" }) },
		);
		expect(invalidTarget.status).toBe(404);

		const invalidJson = await handlers.submitResults(
			new Request("http://api.local", {
				method: "POST",
				headers,
				body: "{",
			}),
			CONTEXT,
		);
		expect(invalidJson.status).toBe(400);
		expect(submitResults).not.toHaveBeenCalled();
	});

	it("发布者验收会保留钱包身份、节点归属和幂等键，并返回可携带 Cookie 的跨源响应", async () => {
		const accept = vi.fn(async () => ({
			statusCode: 200,
			body: { nodeStatus: "accepted" },
		}));
		const handlers = createPublisherWorkflowExecutionHandlers({
			resolveActorId: vi.fn(async () => ACTOR_ID),
			previewAcceptance: vi.fn(),
			accept,
			rework: vi.fn(),
			allowedOrigin: "http://web.local",
		});
		const raw = {
			resultId: RESULT_ID,
			expectedNodeVersion: "4",
			expectedSettlement: {
				grossAmountMinor: "12000000",
				platformFeeMinor: "50000",
				agentAmountMinor: "11950000",
				feeRuleVersion: "fee-v3-usdc",
			},
		};

		const response = await handlers.accept(
			new Request("http://api.local", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "workflow-accept-1",
				},
				body: JSON.stringify(raw),
			}),
			CONTEXT,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"http://web.local",
		);
		expect(response.headers.get("access-control-allow-credentials")).toBe(
			"true",
		);
		expect(accept).toHaveBeenCalledWith(
			TASK_ID,
			NODE_ID,
			raw,
			ACTOR_ID,
			"workflow-accept-1",
		);
	});

	it("区分无效会话和认证服务故障，避免把数据库故障误报成用户未登录", async () => {
		const invalidHandlers = createPublisherWorkflowExecutionHandlers({
			resolveActorId: vi.fn(async () => {
				throw new SessionInvalidError();
			}),
			previewAcceptance: vi.fn(),
			accept: vi.fn(),
			rework: vi.fn(),
			allowedOrigin: "http://web.local",
		});
		const unavailableHandlers = createPublisherWorkflowExecutionHandlers({
			resolveActorId: vi.fn(async () => {
				throw new Error("database unavailable");
			}),
			previewAcceptance: vi.fn(),
			accept: vi.fn(),
			rework: vi.fn(),
			allowedOrigin: "http://web.local",
		});

		const invalid = await invalidHandlers.previewAcceptance(
			new Request(`http://api.local?resultId=${RESULT_ID}`),
			CONTEXT,
		);
		const unavailable = await unavailableHandlers.previewAcceptance(
			new Request(`http://api.local?resultId=${RESULT_ID}`),
			CONTEXT,
		);

		expect(invalid.status).toBe(401);
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toMatchObject({
			error_code: "AUTH_SERVICE_UNAVAILABLE",
			retryable: true,
		});
	});
});
