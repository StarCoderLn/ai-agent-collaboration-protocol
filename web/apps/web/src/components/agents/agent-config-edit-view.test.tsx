import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentConfigEditView from "./agent-config-edit-view";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const baseAgentBody = {
	id: "agent-123",
	providerWalletAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
	name: "Translator Agent",
	categoryId: "3f9e2c2e-6b2a-4f0e-9c1a-2f7a5b6c8d9e",
	capabilityDesc: "中英互译",
	tags: ["翻译"],
	pricingType: "per_task",
	priceAmount: "1000",
	priceCurrency: "USDC",
	serviceEndpoint: "https://agent.example.com/run",
	email: "provider@example.com",
	status: "active",
	pauseReason: null,
	createdAt: "2026-08-20T00:00:00.000Z",
	updatedAt: "2026-08-20T00:00:00.000Z",
};

describe("AgentConfigEditView", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("加载成功后渲染编辑表单与凭证替换入口", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(baseAgentBody), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		render(<AgentConfigEditView agentId="agent-123" />);

		expect(
			await screen.findByRole("heading", { name: "编辑 Agent 配置" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("邮箱")).toHaveValue("provider@example.com");
		expect(screen.getByLabelText("新认证配置")).toBeInTheDocument();
	});

	it("档案不存在（404）时展示空态", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error_code: "AGENT_NOT_FOUND",
					message: "未找到该 Agent",
					retryable: false,
				}),
				{ status: 404, headers: { "content-type": "application/json" } },
			),
		);

		render(<AgentConfigEditView agentId="missing-agent" />);

		expect(await screen.findByText("未找到该 Agent 档案")).toBeInTheDocument();
	});

	it("加载失败时展示可重试的错误态", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network error"));

		render(<AgentConfigEditView agentId="agent-123" />);

		expect(await screen.findByText("加载失败")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();

		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify(baseAgentBody), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		screen.getByRole("button", { name: "重试" }).click();

		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "编辑 Agent 配置" }),
			).toBeInTheDocument(),
		);
	});

	it("丢弃过期请求的响应：agentId 切换后，旧请求延迟返回也不会覆盖新 Agent 的数据", async () => {
		let resolveFirst: (response: Response) => void = () => {};
		const firstFetch = new Promise<Response>((resolve) => {
			resolveFirst = resolve;
		});

		vi.mocked(fetch)
			.mockReturnValueOnce(firstFetch)
			.mockResolvedValueOnce(
				jsonResponse({
					...baseAgentBody,
					id: "agent-456",
					name: "Second Agent",
				}),
			);

		const { rerender } = render(<AgentConfigEditView agentId="agent-123" />);

		rerender(<AgentConfigEditView agentId="agent-456" />);

		expect(await screen.findByText("Second Agent")).toBeInTheDocument();

		// 旧请求这才姗姗来迟地 resolve；不应把已经切到 agent-456 的界面覆盖回 agent-123。
		resolveFirst(
			jsonResponse({ ...baseAgentBody, id: "agent-123", name: "First Agent" }),
		);

		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(screen.getByText("Second Agent")).toBeInTheDocument();
		expect(screen.queryByText("First Agent")).not.toBeInTheDocument();
	});
});
