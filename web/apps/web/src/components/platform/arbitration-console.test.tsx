import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	getTaskDispute,
	submitTaskDisputeEvidenceWithOptionalFile,
} from "@/lib/api/tasks";
import ArbitrationConsole from "./arbitration-console";

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({
		status: "connected",
		walletAddress: "0x3333333333333333333333333333333333333333",
		error: null,
		connect: vi.fn(),
	}),
}));

vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return {
		...actual,
		getTaskDispute: vi.fn(),
		decideTaskDispute: vi.fn(),
		submitTaskDisputeEvidenceWithOptionalFile: vi.fn(),
	};
});

/** 平台角色与 DAO 小组成员共用卷宗读取权限，但必须被引导到不同的资金裁决入口。 */
describe("arbitration console", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

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
			evidence: [
				{
					id: "a1000000-0000-4000-8000-000000000003",
					submittedBy: "0x1111111111111111111111111111111111111111",
					party: "publisher",
					description: "验收日志显示失败分支没有执行。",
					attachments: [
						{
							name: "failure-report.txt",
							mimeType: "text/plain",
							sizeBytes: "19",
							storageRef: `evidence-db:a1000000-0000-4000-8000-000000000004:${"44".repeat(32)}`,
						},
					],
					createdAt: "2026-08-23T00:10:00.000Z",
				},
			],
			decision: null,
			viewerRole: "arbitrator",
			viewerCanPlatformDecide: true,
			daoArbitration: null,
		});

		render(
			<ArbitrationConsole disputeId="a1000000-0000-4000-8000-000000000001" />,
		);

		expect(await screen.findByText("争议卷宗与资金决定")).toBeInTheDocument();
		expect(screen.getByText("9,007,199,254.740993 USDC")).toBeInTheDocument();
		expect(screen.getByDisplayValue("9007199254740993")).toBeInTheDocument();
		expect(screen.getByText("金额守恒校验通过")).toBeInTheDocument();
		expect(
			screen.getByText("验收日志显示失败分支没有执行。"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "下载附件 failure-report.txt" }),
		).toBeEnabled();
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
			viewerCanPlatformDecide: true,
			daoArbitration: null,
		});

		render(
			<ArbitrationConsole disputeId="a1000000-0000-4000-8000-000000000011" />,
		);

		expect(
			await screen.findByText("执行状态：处理中（等待链上确认）"),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "查看链上记录" })).toHaveAttribute(
			"href",
			`/transactions/0x${"44".repeat(32)}?disputeId=a1000000-0000-4000-8000-000000000011`,
		);
		expect(screen.queryByText(/已完成（链上已确认）/)).not.toBeInTheDocument();
	});

	it("允许争议参与方在卷宗中上传真实文件并补充证据", async () => {
		const dispute = {
			id: "a1000000-0000-4000-8000-000000000031",
			taskId: "a1000000-0000-4000-8000-000000000032",
			openedBy: "0x3333333333333333333333333333333333333333",
			reason: "需要提交真实附件完成链上证据验收。",
			status: "evidence_collection" as const,
			fundsFrozen: true,
			escrowAmountMinor: "1500000",
			evidenceDeadline: "2099-09-11T16:00:00.000Z",
			createdAt: "2026-09-11T15:00:00.000Z",
			evidence: [],
			decision: null,
			viewerRole: "publisher" as const,
			viewerCanPlatformDecide: false,
			daoArbitration: null,
		};
		vi.mocked(getTaskDispute).mockResolvedValue(dispute);
		vi.mocked(submitTaskDisputeEvidenceWithOptionalFile).mockResolvedValue({
			disputeId: dispute.id,
			evidenceId: "a1000000-0000-4000-8000-000000000033",
			party: "publisher",
			submittedAt: "2026-09-11T15:01:00.000Z",
			statusVersion: "2",
		});

		render(<ArbitrationConsole disputeId={dispute.id} />);

		fireEvent.change(await screen.findByLabelText("补充文字证据"), {
			target: { value: "浏览器上传的真实文本附件用于复核 SHA-256。" },
		});
		const file = new File(["DAO evidence\n"], "dao-evidence.txt", {
			type: "text/plain",
		});
		fireEvent.change(screen.getByLabelText("添加证据文件（可选）"), {
			target: { files: [file] },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交证据" }));

		await waitFor(() =>
			expect(submitTaskDisputeEvidenceWithOptionalFile).toHaveBeenCalledWith(
				dispute.id,
				"浏览器上传的真实文本附件用于复核 SHA-256。",
				file,
				expect.stringMatching(/^dispute-evidence:/),
			),
		);
	});

	it("routes a DAO panel member to independent voting instead of the platform decision form", async () => {
		vi.mocked(getTaskDispute).mockResolvedValue({
			id: "a1000000-0000-4000-8000-000000000021",
			taskId: "a1000000-0000-4000-8000-000000000022",
			openedBy: "0x1111111111111111111111111111111111111111",
			reason: "需要由无利益冲突的小组核对多 Agent 交付。",
			status: "evidence_collection",
			fundsFrozen: true,
			escrowAmountMinor: "100000000",
			evidenceDeadline: "2026-09-05T00:00:00.000Z",
			createdAt: "2026-09-02T00:00:00.000Z",
			evidence: [],
			decision: null,
			viewerRole: "arbitrator",
			viewerCanPlatformDecide: false,
			daoArbitration: {
				roundId: "a1000000-0000-4000-8000-000000000023",
				status: "voting",
				panelSize: 3,
				panelCount: 3,
				quorum: 2,
				voteCount: 1,
				votes: { release: 0, partialRelease: 1, refund: 0 },
				viewerHasVoted: false,
				evidenceRoot: null,
				votingDeadline: "2026-09-05T00:00:00.000Z",
				decidedAt: null,
			},
		});

		render(
			<ArbitrationConsole disputeId="a1000000-0000-4000-8000-000000000021" />,
		);

		expect(
			await screen.findByText("请在 DAO 仲裁页提交投票"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "前往 DAO 投票" }),
		).toHaveAttribute("href", "/dao");
		expect(screen.queryByText("记录仲裁结论")).not.toBeInTheDocument();
	});
});
