import { describe, expect, it } from "vitest";

import {
	aggregateWorkflowStatus,
	assertValidWorkflowGraph,
	transitionWorkflowNode,
	unlockReadyWorkflowNodes,
	type WorkflowNodeSnapshot,
	WorkflowStateError,
} from "./workflow-state";

const nodes = (
	statuses: readonly WorkflowNodeSnapshot["status"][],
): WorkflowNodeSnapshot[] =>
	statuses.map((status, index) => ({ id: `node-${index + 1}`, status }));

describe("formal workflow state", () => {
	it("在托管前只冻结候选，托管确认后再按依赖激活节点", () => {
		expect(
			transitionWorkflowNode("selecting", { type: "candidate_selected" }),
		).toBe("selected");
		expect(
			transitionWorkflowNode("selected", { type: "root_execution_activated" }),
		).toBe("matching");
		expect(
			transitionWorkflowNode("selected", {
				type: "dependent_execution_activated",
			}),
		).toBe("blocked");
	});

	it("按分配、接单、交付和验收顺序推进节点", () => {
		expect(
			transitionWorkflowNode("matching", { type: "assignment_locked" }),
		).toBe("awaiting_agent_acceptance");
		expect(
			transitionWorkflowNode("awaiting_agent_acceptance", {
				type: "agent_accepted",
			}),
		).toBe("executing");
		expect(
			transitionWorkflowNode("executing", { type: "results_submitted" }),
		).toBe("awaiting_review");
		expect(
			transitionWorkflowNode("awaiting_review", { type: "result_accepted" }),
		).toBe("accepted");
	});

	it("拒绝乱序验收，不能把未交付节点直接标记完成", () => {
		expect(() =>
			transitionWorkflowNode("executing", { type: "result_accepted" }),
		).toThrow(
			new WorkflowStateError(
				"INVALID_NODE_TRANSITION",
				"workflow node cannot apply result_accepted from executing",
			),
		);
	});

	it("只允许仓储已验证的旧执行快照恢复正在执行节点", () => {
		expect(
			transitionWorkflowNode("executing", { type: "stale_execution_recovery" }),
		).toBe("matching");
		expect(() =>
			transitionWorkflowNode("executing", { type: "assignment_failed" }),
		).toThrow(/workflow node cannot apply assignment_failed from executing/);
	});

	it("共同上游验收后同时解锁并行节点，下游仍等待所有分支", () => {
		const current = nodes(["accepted", "blocked", "blocked", "blocked"]);
		const first = unlockReadyWorkflowNodes(current, [
			{ sourceNodeId: "node-1", targetNodeId: "node-2" },
			{ sourceNodeId: "node-1", targetNodeId: "node-3" },
			{ sourceNodeId: "node-2", targetNodeId: "node-4" },
			{ sourceNodeId: "node-3", targetNodeId: "node-4" },
		]);
		expect(first.map((node) => node.status)).toEqual([
			"accepted",
			"matching",
			"matching",
			"blocked",
		]);
		const second = unlockReadyWorkflowNodes(
			first.map((node) =>
				node.id === "node-2" ? { ...node, status: "accepted" } : node,
			),
			[
				{ sourceNodeId: "node-1", targetNodeId: "node-2" },
				{ sourceNodeId: "node-1", targetNodeId: "node-3" },
				{ sourceNodeId: "node-2", targetNodeId: "node-4" },
				{ sourceNodeId: "node-3", targetNodeId: "node-4" },
			],
		);
		expect(second[3]?.status).toBe("blocked");
	});

	it("拒绝环形依赖，避免工作流永远无法解锁", () => {
		expect(() =>
			assertValidWorkflowGraph(nodes(["blocked", "blocked"]), [
				{ sourceNodeId: "node-1", targetNodeId: "node-2" },
				{ sourceNodeId: "node-2", targetNodeId: "node-1" },
			]),
		).toThrow(/acyclic/);
	});

	it("从节点事实计算工作流聚合状态", () => {
		expect(aggregateWorkflowStatus(nodes(["accepted", "accepted"]))).toBe(
			"completed",
		);
		expect(
			aggregateWorkflowStatus(nodes(["accepted", "awaiting_review"])),
		).toBe("awaiting_review");
		expect(aggregateWorkflowStatus(nodes(["executing", "disputed"]))).toBe(
			"disputed",
		);
		expect(
			aggregateWorkflowStatus(nodes(["execution_failed", "blocked"])),
		).toBe("failed");
	});
});
