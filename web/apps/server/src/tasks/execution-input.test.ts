import { describe, expect, it } from "vitest";

import {
	acceptResultInputSchema,
	executionStatusInputSchema,
	resultSubmissionInputSchema,
	workflowExecutionStatusInputSchema,
} from "./execution-input";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNMENT_ID = "22222222-2222-4222-8222-222222222222";

describe("execution input contracts", () => {
	it("accepts a stable failure category for a formal workflow node", () => {
		expect(
			workflowExecutionStatusInputSchema.safeParse({
				agentId: AGENT_ID,
				assignmentId: ASSIGNMENT_ID,
				state: "failed",
				failureCode: "MODEL_OUTPUT_INVALID",
				reportedAt: "2026-08-23T01:00:00.000Z",
			}).success,
		).toBe(true);
	});

	it("keeps the legacy single-Agent failure contract narrow", () => {
		expect(
			executionStatusInputSchema.safeParse({
				agentId: AGENT_ID,
				assignmentId: ASSIGNMENT_ID,
				state: "failed",
				failureCode: "MODEL_OUTPUT_INVALID",
				reportedAt: "2026-08-23T01:00:00.000Z",
			}).success,
		).toBe(false);
	});

	it("accepts a bounded needs-input request with a non-regressing ETA", () => {
		expect(
			executionStatusInputSchema.safeParse({
				agentId: AGENT_ID,
				assignmentId: ASSIGNMENT_ID,
				state: "needs_input",
				progress: 45,
				reportedAt: "2026-08-23T01:00:00.000Z",
				estimatedCompletionAt: "2026-08-23T02:00:00.000Z",
				message: "请确认是否需要额外导出 JSON Schema。",
			}).success,
		).toBe(true);
	});

	it("接受标准 Content-Type 参数并只持久化基础 MIME", () => {
		const parsed = resultSubmissionInputSchema.parse({
			agentId: AGENT_ID,
			assignmentId: ASSIGNMENT_ID,
			results: [
				{
					kind: "inline",
					summary: "资料调研报告",
					mimeType: "text/markdown; charset=utf-8",
					content: "# 调研结果",
					generatedAt: "2026-09-13T05:25:20.000Z",
				},
			],
		});

		expect(parsed.results[0]?.mimeType).toBe("text/markdown");
	});

	it("rejects an ETA before the report and unbounded attention text", () => {
		expect(
			executionStatusInputSchema.safeParse({
				agentId: AGENT_ID,
				assignmentId: ASSIGNMENT_ID,
				state: "needs_input",
				progress: 45,
				reportedAt: "2026-08-23T02:00:00.000Z",
				estimatedCompletionAt: "2026-08-23T01:00:00.000Z",
				message: "问题",
			}).success,
		).toBe(false);
		expect(
			executionStatusInputSchema.safeParse({
				agentId: AGENT_ID,
				assignmentId: ASSIGNMENT_ID,
				state: "needs_input",
				progress: 45,
				reportedAt: "2026-08-23T01:00:00.000Z",
				message: "问".repeat(2_001),
			}).success,
		).toBe(false);
	});

	it("requires the exact preview terms when accepting a result", () => {
		expect(
			acceptResultInputSchema.safeParse({ resultId: AGENT_ID }).success,
		).toBe(false);
		expect(
			acceptResultInputSchema.safeParse({
				resultId: AGENT_ID,
				expectedStatusVersion: "9",
				expectedSettlement: {
					grossAmountMinor: "24000000",
					platformFeeMinor: "50000",
					agentAmountMinor: "23950000",
					feeRuleVersion: "fee-v3-usdc",
				},
			}).success,
		).toBe(true);
	});
});
