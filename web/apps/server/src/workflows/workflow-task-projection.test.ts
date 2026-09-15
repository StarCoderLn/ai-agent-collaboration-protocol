import { describe, expect, it } from "vitest";
import type { WorkflowNodeStatus } from "./workflow-state";
import { projectWorkflowTaskStatus } from "./workflow-task-projection";

describe("workflow task projection", () => {
	it("按需要人工处理和失败的优先级投影并允许 DAG 进入下游匹配", () => {
		expect(project("executing", ["accepted", "matching"])).toBe("matching");
		expect(project("matching", ["accepted", "executing"])).toBe("executing");
		expect(project("executing", ["executing", "awaiting_review"])).toBe(
			"awaiting_review",
		);
		expect(project("awaiting_review", ["awaiting_review", "rework"])).toBe(
			"rework",
		);
		expect(project("rework", ["rework", "execution_failed"])).toBe(
			"execution_failed",
		);
	});

	it("不覆盖争议和资金终态，全部验收后等待最终资金授权入口推进", () => {
		expect(project("awaiting_escrow", ["selected", "blocked"])).toBe(
			"awaiting_escrow",
		);
		expect(project("disputed", ["executing"])).toBe("disputed");
		expect(project("pending_settlement", ["awaiting_review"])).toBe(
			"pending_settlement",
		);
		expect(project("awaiting_review", ["accepted", "accepted"])).toBe(
			"awaiting_review",
		);
	});
});

function project(
	current: Parameters<typeof projectWorkflowTaskStatus>[0],
	statuses: WorkflowNodeStatus[],
) {
	return projectWorkflowTaskStatus(
		current,
		statuses.map((status, index) => ({ id: String(index), status })),
	);
}
