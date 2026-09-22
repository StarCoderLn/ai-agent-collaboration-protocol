import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import AgentMarketplace from "./agent-marketplace";

const agent = {
	id: "83100000-0000-4000-8000-000000000001",
	name: "真实目录 Coding Agent",
	categoryId: "40000000-0000-4000-8000-000000000023",
	// 故意保留服务端完整路径，证明筛选依据是分类 ID，而不是易变化的展示名称。
	categoryName: "产品与开发 / 软件开发",
	provider: { label: "0x1234…5678" },
	description: "来自正式 Agent 目录 API",
	tags: ["TypeScript", "测试"],
	pricing: { type: "fixed", amountMinor: "25000000", currency: "USDC" },
	status: "active",
	// 模拟旧接口或缓存仍返回 3.5 冷启动先验，页面必须根据零样本证据隐藏它。
	score: 3.5,
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
			Response.json({ agents: [agent], total: 1, limit: 9, offset: 0 }),
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
		renderMarketplace(<AgentMarketplace />);

		expect(
			await screen.findByText("真实目录 Coding Agent"),
		).toBeInTheDocument();
		expect(screen.getByText("来自正式 Agent 目录 API")).toBeInTheDocument();
		expect(screen.getByText("Agent 提供者")).toBeInTheDocument();
		expect(screen.getByText("0x1234…5678")).toBeInTheDocument();
		expect(screen.getByText("新 Agent")).toHaveAttribute(
			"title",
			"尚无已验收并结算的真实任务记录",
		);
		expect(screen.queryByText("健康探测正常")).not.toBeInTheDocument();
		expect(screen.getByText("暂无评分")).toBeInTheDocument();
		expect(screen.queryByText("3.5")).not.toBeInTheDocument();
		expect(screen.getByText("单次服务价")).toBeInTheDocument();
		expect(screen.getByText("25 USDC")).toHaveClass("text-primary");
		expect(screen.queryByText("参考报价")).not.toBeInTheDocument();
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
		expect(screen.queryByText("计费方式")).not.toBeInTheDocument();
		expect(screen.queryByText("按任务计费")).not.toBeInTheDocument();
		expect(screen.getByLabelText("按能力分类筛选")).toHaveTextContent(
			"全部分类",
		);

		fireEvent.click(screen.getByLabelText("按能力分类筛选"));
		expect(
			screen.queryByRole("option", { name: "产品与开发" }),
		).not.toBeInTheDocument();
		const codeCategory = await screen.findByRole("option", {
			name: "软件与网站开发",
		});
		fireEvent.pointerDown(codeCategory, { pointerType: "mouse" });
		fireEvent.click(codeCategory);
		// 分类切换会触发新的服务端分页查询；等待请求完成后再验证结果，避免把旧版
		// 客户端同步筛选的时序继续固化进测试。
		expect(
			await screen.findByText("真实目录 Coding Agent"),
		).toBeInTheDocument();
	});

	it("英文界面翻译平台内置 Agent，但不改写用户自定义目录数据", async () => {
		const builtInAgent = {
			...agent,
			name: "网页调研助手",
			categoryName: "研究分析",
			description:
				"根据指定公开网页收集、核对并整理信息，交付带来源、访问时间与异常说明的结构化调研报告",
		};
		const customAgent = {
			...agent,
			id: "83100000-0000-4000-8000-000000000002",
			name: "Alice 的品牌写作助手",
			categoryName: "用户自定义分类",
			description: "用户自定义能力说明",
		};
		vi.mocked(fetch).mockImplementation((input) => {
			const url = String(input);
			if (url.includes("/market/agents")) {
				return Promise.resolve(
					Response.json({
						agents: [builtInAgent, customAgent],
						total: 2,
						limit: 9,
						offset: 0,
					}),
				);
			}
			if (url.endsWith("/categories")) {
				return Promise.resolve(Response.json({ categories }));
			}
			return Promise.reject(new Error(`Unexpected request: ${url}`));
		});

		renderMarketplace(
			<LocaleProvider initialLocale="en">
				<AgentMarketplace />
			</LocaleProvider>,
		);

		expect(
			await screen.findByText("Web Research Assistant"),
		).toBeInTheDocument();
		expect(screen.getByText("Research & analysis")).toBeInTheDocument();
		expect(
			screen.getByText(/Collect, verify, and organize information/),
		).toBeInTheDocument();
		expect(screen.getByText("用户自定义能力说明")).toBeInTheDocument();
		expect(screen.getByText("Alice 的品牌写作助手")).toBeInTheDocument();
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
		renderMarketplace(<AgentMarketplace />);

		expect(await screen.findByText("Agent 市场暂时不可用")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
		await waitFor(() =>
			expect(screen.getByText("真实目录 Coding Agent")).toBeInTheDocument(),
		);
	});

	it("requests the second server page when the user changes page", async () => {
		const secondPageAgent = {
			...agent,
			id: "83100000-0000-4000-8000-000000000010",
			name: "第二页设计 Agent",
		};
		vi.mocked(fetch).mockImplementation((input) => {
			const url = String(input);
			if (url.includes("/market/agents")) {
				const isSecondPage = url.includes("offset=9");
				return Promise.resolve(
					Response.json({
						agents: [isSecondPage ? secondPageAgent : agent],
						total: 18,
						limit: 9,
						offset: isSecondPage ? 9 : 0,
					}),
				);
			}
			if (url.endsWith("/categories")) {
				return Promise.resolve(Response.json({ categories }));
			}
			return Promise.reject(new Error(`Unexpected request: ${url}`));
		});
		renderMarketplace(<AgentMarketplace />);

		expect(
			await screen.findByText("真实目录 Coding Agent"),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "第 2 页" }));

		expect(await screen.findByText("第二页设计 Agent")).toBeInTheDocument();
		expect(
			vi
				.mocked(fetch)
				.mock.calls.some(([input]) => String(input).includes("offset=9")),
		).toBe(true);
	});
});

function renderMarketplace(children: React.ReactNode): void {
	// 每次渲染使用全新的 QueryClient，避免前一个测试的成功数据或错误状态影响下一个
	// 用例；关闭重试则让失败场景只消耗测试明确安排的一次请求。
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
	);
}
