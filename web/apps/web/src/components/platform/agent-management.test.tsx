import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	listOwnedAgents,
	retryAgentAdmission,
	transitionOwnedAgent,
} from "@/lib/api/agent-directory";
import AgentManagement from "./agent-management";

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({
		status: "connected",
		walletAddress: "0x1111111111111111111111111111111111111111",
		error: null,
		connect: vi.fn(),
	}),
}));
vi.mock("@/lib/api/agent-directory", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/api/agent-directory")>();
	return {
		...actual,
		listOwnedAgents: vi.fn(),
		retryAgentAdmission: vi.fn(),
		transitionOwnedAgent: vi.fn(),
	};
});

function managedAgent(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		name: "提供者 Coding Agent",
		categoryId: "40000000-0000-4000-8000-000000000001",
		categoryName: "代码开发",
		provider: { label: "0x1111…1111" },
		description: "根据需求生成代码",
		tags: ["coding"],
		pricing: { type: "per_task", amountMinor: "1000", currency: "USDC" },
		status: "active" as const,
		score: null,
		sampleSize: 0,
		disputeRate: null,
		completedCount: 0,
		successRate: null,
		isNew: true,
		coldStart: { riskLimited: true, completedTaskThreshold: 3 },
		createdAt: "2026-08-23T00:00:00.000Z",
		updatedAt: "2026-08-23T00:00:00.000Z",
		providerWalletAddress: "0x1111111111111111111111111111111111111111",
		serviceEndpoint: "https://agent.example/v1/tasks",
		email: "provider@example.com",
		pauseReason: null,
		admission: null,
		health: {
			status: "healthy" as const,
			checkedAt: "2026-08-23T00:00:00.000Z",
			consecutiveFailureCount: 0,
			consecutiveSuccessCount: 0,
			intervalSeconds: 300,
		},
		...overrides,
	};
}

describe("Agent provider management", () => {
	beforeEach(() =>
		vi.mocked(listOwnedAgents).mockResolvedValue([
			managedAgent("83100000-0000-4000-8000-000000000001"),
			managedAgent("83100000-0000-4000-8000-000000000002", {
				name: "健康恢复中的 Agent",
				status: "paused",
				pauseReason: "health_check",
				isNew: false,
				coldStart: { riskLimited: false, completedTaskThreshold: 3 },
				health: {
					status: "degraded",
					checkedAt: "2026-08-23T00:00:00.000Z",
					consecutiveFailureCount: 0,
					consecutiveSuccessCount: 1,
					intervalSeconds: 300,
				},
			}),
		]),
	);
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("explains cold-start progress without exposing scoring jargon and prevents provider bypass of health recovery", async () => {
		const onInventoryChange = vi.fn();
		render(<AgentManagement onInventoryChange={onInventoryChange} />);

		expect(await screen.findByText("新 Agent")).toHaveAttribute(
			"title",
			"尚无已验收并结算的真实任务记录",
		);
		expect(screen.getByText(/完成首个真实任务后/)).toBeInTheDocument();
		expect(screen.queryByText(/平台先验权重/)).not.toBeInTheDocument();
		expect(screen.getByText("平台健康检查已自动暂停接单")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "恢复接单" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "暂停接单" }),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(onInventoryChange).toHaveBeenLastCalledWith(true),
		);
	});

	it("reports an empty inventory so the page header does not duplicate the empty-state action", async () => {
		vi.mocked(listOwnedAgents).mockResolvedValue([]);
		const onInventoryChange = vi.fn();
		render(<AgentManagement onInventoryChange={onInventoryChange} />);

		expect(
			await screen.findByRole("button", { name: "上架第一个 Agent" }),
		).toHaveAttribute("href", "/agents/register");
		await waitFor(() =>
			expect(onInventoryChange).toHaveBeenLastCalledWith(false),
		);
	});

	it("requires explicit confirmation before permanently delisting an owned Agent", async () => {
		render(<AgentManagement />);

		const delistButton = (
			await screen.findAllByRole("button", { name: "下架" })
		)[0];
		if (delistButton === undefined)
			throw new Error("测试夹具必须包含可下架 Agent");
		fireEvent.click(delistButton);
		expect(screen.getByText("确认永久下架这个 Agent？")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "确认下架" }));

		await waitFor(() =>
			expect(transitionOwnedAgent).toHaveBeenCalledWith(
				"83100000-0000-4000-8000-000000000001",
				"delist",
				expect.any(String),
			),
		);
	});

	// 模拟服务端已经收到重试、但响应丢失：再次确认只能重放同一请求，不能新开付费轮次。
	it("confirms trial costs and reuses the retry key after a lost response", async () => {
		vi.mocked(listOwnedAgents).mockResolvedValue([
			managedAgent("83100000-0000-4000-8000-000000000003", {
				status: "pending_review",
				admission: {
					status: "failed",
					attemptNo: 1,
					completedRuns: 3,
					score: 64,
					summary: "产物遗漏了关键验收要求。",
					failureCode: "ADMISSION_QUALITY_NOT_PASSED",
					startedAt: "2026-08-23T00:00:00.000Z",
					completedAt: "2026-08-23T00:05:00.000Z",
				},
			}),
		]);
		vi.mocked(retryAgentAdmission)
			.mockRejectedValueOnce(new Error("网络连接中断"))
			.mockResolvedValue({
				agentId: "83100000-0000-4000-8000-000000000003",
				roundId: "83100000-0000-4000-8000-000000000004",
				attemptNo: 2,
				status: "queued",
			});
		render(<AgentManagement />);

		expect(await screen.findByText("自动验证未通过")).toBeInTheDocument();
		expect(screen.getByText("评分 64/100")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "重新验证" }));
		expect(retryAgentAdmission).not.toHaveBeenCalled();
		expect(screen.getByText(/重新验证会再次执行 3 项测试/)).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(retryAgentAdmission).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "重新验证" }));
		fireEvent.click(screen.getByRole("button", { name: "确认重新验证" }));

		await waitFor(() =>
			expect(retryAgentAdmission).toHaveBeenCalledWith(
				"83100000-0000-4000-8000-000000000003",
				expect.any(String),
			),
		);
		// 未经 API 校验的网络异常使用统一提示，不将底层异常原文直接暴露给用户。
		expect(await screen.findByText("操作失败，请稍后重试")).toBeInTheDocument();
		const firstRequest = vi.mocked(retryAgentAdmission).mock.calls[0];
		if (firstRequest === undefined) throw new Error("必须先发生一次重试请求");
		fireEvent.click(screen.getByRole("button", { name: "重新验证" }));
		fireEvent.click(screen.getByRole("button", { name: "确认重新验证" }));
		await waitFor(() => expect(retryAgentAdmission).toHaveBeenCalledTimes(2));
		expect(vi.mocked(retryAgentAdmission).mock.calls[1]).toEqual(firstRequest);
		expect(await screen.findByText("已开始新一轮自动验证")).toBeInTheDocument();
	});
});
