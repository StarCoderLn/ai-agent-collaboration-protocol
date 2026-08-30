import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type {
	TaskAssignmentResult,
	TaskCandidateRecord,
	TaskExecutionStatus,
} from "@/lib/api/tasks";
import TaskAgentAllocationGraph from "./task-agent-allocation-graph";

const taskId = "11111111-1111-4111-8111-111111111111";
const firstAgentId = "22222222-2222-4222-8222-222222222221";
const selectedAgentId = "22222222-2222-4222-8222-222222222222";
const candidates = {
	id: "33333333-3333-4333-8333-333333333333",
	taskId,
	ruleVersion: "ranking-v1",
	inputFingerprint: "fingerprint",
	inputSnapshot: {},
	candidates: [
		{
			agentId: firstAgentId,
			name: "Interface Scout",
			matchedTags: ["dashboard"],
			quoteMinor: "18000000",
			estimatedDurationSeconds: 900,
			score: 4.7,
			completed: 18,
			responseMinutes: 3,
			isNew: false,
			rankScore: "980",
		},
		{
			agentId: selectedAgentId,
			name: "Trusted Builder",
			matchedTags: ["next.js", "testing"],
			quoteMinor: "22000000",
			estimatedDurationSeconds: 1200,
			score: 4.9,
			completed: 31,
			responseMinutes: 2,
			isNew: false,
			rankScore: "970",
		},
	],
	filterReasons: {},
	finalSelectionAgentId: selectedAgentId,
	createdAt: "2026-08-23T00:00:00.000Z",
} satisfies TaskCandidateRecord;
const assignment = {
	assignment: {
		id: "44444444-4444-4444-8444-444444444444",
		taskId,
		agentId: selectedAgentId,
		agreedAmountMinor: "21000000",
		idempotencyKey: "assignment-request",
		assignedBy: "publisher",
		version: "1",
		status: "accepted",
		lockedAt: "2026-08-23T00:00:00.000Z",
		acceptBy: "2026-08-23T00:05:00.000Z",
		respondedAt: "2026-08-23T00:01:00.000Z",
	},
	dispatchAttempt: {
		id: "55555555-5555-4555-8555-555555555555",
		assignmentId: "44444444-4444-4444-8444-444444444444",
		idempotencyKey: "dispatch-request",
		protocolRequestId: "protocol-request",
		status: "accepted",
		attemptNo: 1,
	},
	replayed: false,
} satisfies TaskAssignmentResult;
const execution = {
	taskId,
	status: "executing",
	statusVersion: "8",
	progress: 64,
	lastReportedAt: "2026-08-23T00:03:00.000Z",
	executionState: "running",
	failureCode: null,
	failedAt: null,
	lastEventId: "8",
} satisfies TaskExecutionStatus;

describe("TaskAgentAllocationGraph", () => {
	afterEach(cleanup);

	it("已有有效分配后只展示真正参与执行的 Agent", () => {
		const view = render(
			<TaskAgentAllocationGraph
				task={{ id: taskId, title: "开发可信任务工作台", status: "executing" }}
				candidates={candidates}
				assignment={assignment}
				execution={execution}
				currency="USDC"
			/>,
		);

		const selectedNode = screen.getByTestId(
			`allocation-agent-${selectedAgentId}`,
		);
		expect(selectedNode).toHaveAttribute("data-selected", "true");
		expect(
			screen.queryByTestId(`allocation-agent-${firstAgentId}`),
		).not.toBeInTheDocument();
		expect(screen.getByText("最终分配的执行 Agent")).toBeInTheDocument();
		expect(screen.getAllByText("64%").length).toBeGreaterThanOrEqual(1);
		expect(view.container.querySelectorAll('[data-selected="true"]')).toHaveLength(1);
	});

	it("尚未形成有效分配时展示全部候选并允许比较", () => {
		render(
			<TaskAgentAllocationGraph
				task={{ id: taskId, title: "开发可信任务工作台", status: "matching" }}
				candidates={candidates}
				assignment={null}
				execution={null}
				currency="USDC"
			/>,
		);

		fireEvent.click(
			within(screen.getByTestId(`allocation-agent-${firstAgentId}`)).getByRole(
				"button",
				{ hidden: true },
			),
		);

		expect(screen.getByText("正在查看候选 Agent")).toBeInTheDocument();
		expect(screen.getByTestId(`allocation-agent-${selectedAgentId}`)).toBeInTheDocument();
		expect(
			screen.queryByText("最终分配的执行 Agent"),
		).not.toBeInTheDocument();
	});

	it("兼容任务的只读关系图同样允许页面滚动并保留视口恢复入口", () => {
		const { container } = render(
			<TaskAgentAllocationGraph
				task={{ id: taskId, title: "开发可信任务工作台", status: "matching" }}
				candidates={candidates}
				assignment={null}
				execution={null}
				currency="USDC"
			/>,
		);

		const pane = container.querySelector(".react-flow__pane");
		expect(pane).not.toBeNull();
		const wheel = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: 120,
		});
		pane?.dispatchEvent(wheel);

		expect(wheel.defaultPrevented).toBe(false);
		expect(
			screen.getByRole("button", { name: "重新显示全部节点" }),
		).toBeInTheDocument();
	});
});
