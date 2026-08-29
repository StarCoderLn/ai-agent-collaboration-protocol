import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentMarketplace from "./agent-marketplace";

const agent = {
	id: "83100000-0000-4000-8000-000000000001",
	name: "真实目录 Coding Agent",
	categoryId: "40000000-0000-4000-8000-000000000023",
	// 故意保留服务端完整路径，证明筛选依据是分类 ID，而不是易变化的展示名称。
	categoryName: "产品与开发 / 软件开发",
	description: "来自正式 Agent 目录 API",
	tags: ["TypeScript", "测试"],
	pricing: { type: "fixed", amountMinor: "25000000", currency: "USDC" },
	status: "active",
	score: null,
	sampleSize: 0,
	disputeRate: null,
	completedCount: 0,
	successRate: null,
	isNew: true,
	createdAt: "2026-08-23T00:00:00.000Z",
	updatedAt: "2026-08-23T01:00:00.000Z",
	verified: true,
	health: { status: "not_checked", checkedAt: null },
};

const categories = [
	{
		id: "40000000-0000-4000-8000-000000000001",
		parentId: null,
		name: "产品与开发",
		slug: "product-development",
		version: 1,
		children: [
			{
				id: "40000000-0000-4000-8000-000000000023",
				parentId: "40000000-0000-4000-8000-000000000001",
				name: "软件开发",
				slug: "software-development",
				version: 1,
				children: [],
			},
		],
	},
	{
		id: "40000000-0000-4000-8000-000000000012",
		parentId: null,
		name: "图片设计",
		slug: "image-design",
		version: 1,
		children: [],
	},
];

/**
 * Agent 市场会并行读取目录和公共分类树。测试按 URL 返回数据，而不是依赖并发请求的
 * 先后顺序，避免把实现时序误当成业务契约。
 */
function successfulApiResponse(input: RequestInfo | URL): Promise<Response> {
	const url = String(input);
	if (url.includes("/market/agents")) {
		return Promise.resolve(
			Response.json({ agents: [agent], limit: 50, offset: 0 }),
		);
	}
	if (url.endsWith("/categories")) {
		return Promise.resolve(Response.json({ categories }));
	}
	return Promise.reject(new Error(`Unexpected request: ${url}`));
}

describe("AgentMarketplace", () => {
	beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("renders real API data and keeps missing score evidence explicit", async () => {
		vi.mocked(fetch).mockImplementation(successfulApiResponse);
		render(<AgentMarketplace />);

		expect(
			await screen.findByText("真实目录 Coding Agent"),
		).toBeInTheDocument();
		expect(screen.getByText("来自正式 Agent 目录 API")).toBeInTheDocument();
		expect(screen.getAllByText("暂无").length).toBeGreaterThanOrEqual(1);
		expect(screen.getByText("25 USDC")).toBeInTheDocument();
		const cardLink = screen.getByRole("link", {
			name: "查看详情：真实目录 Coding Agent",
		});
		expect(cardLink).toHaveAttribute(
			"href",
			"/agents/83100000-0000-4000-8000-000000000001",
		);
		expect(cardLink).toHaveClass("cursor-pointer");
		expect(cardLink.querySelector("article")).not.toBeNull();
		expect(cardLink.querySelector("a")).toBeNull();
		expect(screen.queryByText("查看详情")).not.toBeInTheDocument();
		expect(screen.getByText("计费方式")).toBeInTheDocument();
		expect(screen.getByText("按任务计费")).toBeInTheDocument();
		expect(screen.getByLabelText("按能力分类筛选")).toHaveTextContent(
			"全部分类",
		);

		fireEvent.click(screen.getByLabelText("按能力分类筛选"));
		expect(
			screen.queryByRole("option", { name: "产品与开发" }),
		).not.toBeInTheDocument();
		const codeCategory = await screen.findByRole("option", {
			name: "代码开发",
		});
		fireEvent.pointerDown(codeCategory, { pointerType: "mouse" });
		fireEvent.click(codeCategory);
		// categoryName 与短名称不同仍能命中，验证筛选使用稳定分类 ID。
		expect(screen.getByText("真实目录 Coding Agent")).toBeInTheDocument();
	});

	it("shows a controlled error state and can retry", async () => {
		let shouldFailAgentRequest = true;
		vi.mocked(fetch).mockImplementation((input) => {
			const url = String(input);
			if (url.includes("/market/agents") && shouldFailAgentRequest) {
				shouldFailAgentRequest = false;
				return Promise.reject(new TypeError("connection refused"));
			}
			return successfulApiResponse(input);
		});
		render(<AgentMarketplace />);

		expect(await screen.findByText("Agent 市场暂时不可用")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
		await waitFor(() =>
			expect(screen.getByText("真实目录 Coding Agent")).toBeInTheDocument(),
		);
	});
});
