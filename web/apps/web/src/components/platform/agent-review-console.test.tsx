import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listReviewAgents, reviewAgent } from "@/lib/api/agent-directory";
import AgentReviewConsole from "./agent-review-console";

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({ status: "connected", walletAddress: "0x1111111111111111111111111111111111111111", error: null, connect: vi.fn() }),
}));

vi.mock("@/lib/api/agent-directory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/agent-directory")>();
	return { ...actual, listReviewAgents: vi.fn(), reviewAgent: vi.fn() };
});

const pendingAgent = {
	id: "83100000-0000-4000-8000-000000000001",
	name: "待审核 Coding Agent",
	categoryId: "40000000-0000-4000-8000-000000000001",
	categoryName: "代码开发",
	description: "根据设计稿生成可运行代码",
	tags: ["coding"],
	pricing: { type: "per_task", amountMinor: "1000", currency: "USDC" },
	status: "pending_review" as const,
	score: null,
	sampleSize: 0,
	disputeRate: null,
	completedCount: 0,
	successRate: null,
	isNew: true,
	createdAt: "2026-08-23T00:00:00.000Z",
	updatedAt: "2026-08-23T00:00:00.000Z",
	providerWalletAddress: "0x2222222222222222222222222222222222222222",
	serviceEndpoint: "https://agent.example/v1/tasks",
	email: "provider@example.com",
	pauseReason: null,
	health: { status: "not_checked" as const, checkedAt: null, consecutiveFailureCount: 0, consecutiveSuccessCount: 0, intervalSeconds: 300 },
};

describe("Agent review console", () => {
	beforeEach(() => {
		vi.mocked(listReviewAgents).mockResolvedValue([pendingAgent]);
		vi.mocked(reviewAgent).mockResolvedValue({
			agentId: pendingAgent.id,
			status: "delisted",
			pauseReason: null,
			updatedAt: "2026-08-23T01:00:00.000Z",
		});
	});
	afterEach(() => { cleanup(); vi.clearAllMocks(); });

	it("offers simple approve and reject actions with an auditable reason", async () => {
		render(<AgentReviewConsole />);

		expect(await screen.findByText("待审核 Coding Agent")).toBeInTheDocument();
		expect(screen.queryByText(/UUID/)).not.toBeInTheDocument();
		const approve = screen.getByRole("button", { name: "审核通过" });
		const reject = screen.getByRole("button", { name: "驳回并下架" });
		expect(approve).toBeDisabled();
		expect(reject).toBeDisabled();

		fireEvent.change(screen.getByLabelText("审核理由"), { target: { value: "服务端点无法完成基础检查" } });
		expect(approve).toBeEnabled();
		expect(reject).toBeEnabled();
		fireEvent.click(reject);

		await waitFor(() => expect(reviewAgent).toHaveBeenCalledWith(
			pendingAgent.id,
			"reject",
			"服务端点无法完成基础检查",
			expect.any(String),
		));
		expect(await screen.findByText("已驳回，Agent 需要修正后重新注册")).toBeInTheDocument();
	});
});
