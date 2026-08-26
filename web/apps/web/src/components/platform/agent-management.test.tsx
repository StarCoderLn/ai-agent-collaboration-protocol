import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listOwnedAgents } from "@/lib/api/agent-directory";
import AgentManagement from "./agent-management";

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({ status: "connected", walletAddress: "0x1111111111111111111111111111111111111111", error: null, connect: vi.fn() }),
}));
vi.mock("@/lib/api/agent-directory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/agent-directory")>();
	return { ...actual, listOwnedAgents: vi.fn(), transitionOwnedAgent: vi.fn() };
});

function managedAgent(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		name: "提供者 Coding Agent",
		categoryId: "40000000-0000-4000-8000-000000000001",
		categoryName: "代码开发",
		description: "根据需求生成代码",
		tags: ["coding"],
		pricing: { type: "per_task", amountMinor: "1000", currency: "ETH" },
		status: "active" as const,
		score: null,
		sampleSize: 0,
		disputeRate: null,
		completedCount: 0,
		successRate: null,
		isNew: true,
		createdAt: "2026-08-23T00:00:00.000Z",
		updatedAt: "2026-08-23T00:00:00.000Z",
		providerWalletAddress: "0x1111111111111111111111111111111111111111",
		serviceEndpoint: "https://agent.example/v1/tasks",
		email: "provider@example.com",
		pauseReason: null,
		health: { status: "healthy" as const, checkedAt: "2026-08-23T00:00:00.000Z", consecutiveFailureCount: 0, consecutiveSuccessCount: 0, intervalSeconds: 300 },
		...overrides,
	};
}

describe("Agent provider management", () => {
	beforeEach(() => vi.mocked(listOwnedAgents).mockResolvedValue([
		managedAgent("83100000-0000-4000-8000-000000000001"),
		managedAgent("83100000-0000-4000-8000-000000000002", {
			name: "健康恢复中的 Agent",
			status: "paused",
			pauseReason: "health_check",
			isNew: false,
			health: { status: "degraded", checkedAt: "2026-08-23T00:00:00.000Z", consecutiveFailureCount: 0, consecutiveSuccessCount: 1, intervalSeconds: 300 },
		}),
	]));
	afterEach(() => { cleanup(); vi.clearAllMocks(); });

	it("explains controlled onboarding and prevents provider bypass of health recovery", async () => {
		render(<AgentManagement />);

		expect(await screen.findByText("新入驻 · 受控上线")).toBeInTheDocument();
		expect(screen.getByText(/历史任务第 30 百分位/)).toBeInTheDocument();
		expect(screen.getByText("平台健康检查已自动暂停接单")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "恢复接单" })).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "暂停接单" })).toBeInTheDocument();
	});
});
