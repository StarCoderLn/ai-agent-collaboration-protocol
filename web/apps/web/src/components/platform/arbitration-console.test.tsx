import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getTaskDispute } from "@/lib/api/tasks";
import ArbitrationConsole from "./arbitration-console";

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({ status: "connected", walletAddress: "0x3333333333333333333333333333333333333333", error: null, connect: vi.fn() }),
}));

vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return { ...actual, getTaskDispute: vi.fn(), decideTaskDispute: vi.fn() };
});

describe("arbitration console", () => {
	afterEach(() => { cleanup(); vi.clearAllMocks(); });

	it("shows server-authorized evidence and pre-fills a money-conserving refund", async () => {
		vi.mocked(getTaskDispute).mockResolvedValue({
			id: "a1000000-0000-4000-8000-000000000001",
			taskId: "a1000000-0000-4000-8000-000000000002",
			openedBy: "0x1111111111111111111111111111111111111111",
			reason: "Agent 没有覆盖约定的失败恢复路径。",
			status: "evidence_collection",
			fundsFrozen: true,
			escrowAmountMinor: "9007199254740993",
			evidenceDeadline: "2026-08-24T00:00:00.000Z",
			createdAt: "2026-08-23T00:00:00.000Z",
			evidence: [{
				id: "a1000000-0000-4000-8000-000000000003",
				submittedBy: "0x1111111111111111111111111111111111111111",
				party: "publisher",
				description: "验收日志显示失败分支没有执行。",
				attachments: [],
				createdAt: "2026-08-23T00:10:00.000Z",
			}],
			decision: null,
			viewerRole: "arbitrator",
		});

		render(<ArbitrationConsole disputeId="a1000000-0000-4000-8000-000000000001" />);

		expect(await screen.findByText("争议卷宗与资金决定")).toBeInTheDocument();
		expect(screen.getByDisplayValue("9007199254740993")).toBeInTheDocument();
		expect(screen.getByText("金额守恒校验通过")).toBeInTheDocument();
		expect(screen.getByText("验收日志显示失败分支没有执行。")).toBeInTheDocument();
		expect(screen.queryByText("本地仲裁员操作")).not.toBeInTheDocument();
	});

	it("shows a submitted arbitration transaction as processing until chain confirmation", async () => {
		vi.mocked(getTaskDispute).mockResolvedValue({
			id: "a1000000-0000-4000-8000-000000000011",
			taskId: "a1000000-0000-4000-8000-000000000012",
			openedBy: "0x1111111111111111111111111111111111111111",
			reason: "Agent 没有覆盖约定的失败恢复路径。",
			status: "decided",
			fundsFrozen: true,
			escrowAmountMinor: "10000",
			evidenceDeadline: "2026-08-24T00:00:00.000Z",
			createdAt: "2026-08-23T00:00:00.000Z",
			evidence: [],
			decision: {
				id: "a1000000-0000-4000-8000-000000000013",
				arbitratorId: "0x3333333333333333333333333333333333333333",
				type: "refund",
				releaseAmountMinor: "0",
				refundAmountMinor: "10000",
				platformFeeMinor: null,
				agentAmountMinor: null,
				agentResponsibility: "agent_at_fault",
				reason: "证据表明交付未满足关键验收条件。",
				executionStatus: "submitted",
				executionTxHash: `0x${"44".repeat(32)}`,
				decidedAt: "2026-08-23T01:00:00.000Z",
				executedAt: null,
			},
			viewerRole: "arbitrator",
		});

		render(<ArbitrationConsole disputeId="a1000000-0000-4000-8000-000000000011" />);

		expect(await screen.findByText("执行状态：处理中（等待链上确认）")).toBeInTheDocument();
		expect(screen.queryByText(/已完成（链上已确认）/)).not.toBeInTheDocument();
	});
});
