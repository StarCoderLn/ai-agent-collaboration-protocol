import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentRegistrationForm from "./agent-registration-form";

const CATEGORY_ID = "3f9e2c2e-6b2a-4f0e-9c1a-2f7a5b6c8d9e";
const CATEGORY_GROUP_ID = "40000000-0000-4000-8000-000000000001";
const CONNECTED_WALLET = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const PAYOUT_WALLET = "0x000000000000000000000000000000000000dEaD";
const writeText = vi.fn(async (_value: string) => {});
const walletMock = vi.hoisted(() => ({
	address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
	status: "connected" as
		| "checking"
		| "disconnected"
		| "connecting"
		| "connected"
		| "error",
	connect: vi.fn(async () => {}),
}));

vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({
		status: walletMock.status,
		walletAddress:
			walletMock.status === "connected" ? walletMock.address : null,
		error: null,
		connect: walletMock.connect,
		logout: vi.fn(),
	}),
}));

function categoryResponse() {
	return new Response(
		JSON.stringify({
			categories: [
				{
					id: CATEGORY_GROUP_ID,
					parentId: null,
					name: "产品与开发",
					slug: "product-development",
					version: 1,
					children: [
						{
							id: CATEGORY_ID,
							parentId: CATEGORY_GROUP_ID,
							name: "软件开发",
							slug: "software-development",
							version: 1,
							children: [],
						},
					],
				},
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function tagResponse() {
	return new Response(
		JSON.stringify({
			query: "",
			suggestions: [
				{ canonicalName: "next.js", matchedAlias: null },
				{ canonicalName: "typescript", matchedAlias: null },
			],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function mockTaxonomyResponses() {
	vi.mocked(fetch)
		.mockResolvedValueOnce(categoryResponse())
		.mockResolvedValueOnce(tagResponse());
}

async function fillValidForm() {
	await screen.findByLabelText("Agent 名称");
	fireEvent.change(screen.getByLabelText("Agent 名称"), {
		target: { value: "Translator Agent" },
	});
	fireEvent.change(screen.getByLabelText("能力说明"), {
		target: { value: "中英互译" },
	});
	fireEvent.change(screen.getByLabelText("Agent 执行地址"), {
		target: { value: "https://agent.example.com/run" },
	});
	fireEvent.change(screen.getByLabelText("访问密钥"), {
		target: { value: "secret" },
	});
	fireEvent.change(screen.getByLabelText("联系邮箱"), {
		target: { value: "provider@example.com" },
	});
	fireEvent.change(screen.getByLabelText("单次服务报价（USDC）"), {
		target: { value: "12" },
	});
	fireEvent.change(screen.getByLabelText("收款钱包"), {
		target: { value: PAYOUT_WALLET },
	});
	const category = screen.getByRole("combobox", { name: "服务分类" });
	fireEvent.click(category);
	const categoryOption = await screen.findByRole("option", {
		name: "代码开发",
	});
	fireEvent.pointerDown(categoryOption, { pointerType: "mouse" });
	fireEvent.click(categoryOption);
	fireEvent.click(await screen.findByRole("button", { name: "next.js" }));
}

describe("AgentRegistrationForm", () => {
	beforeEach(() => {
		walletMock.status = "connected";
		walletMock.connect.mockClear();
		vi.stubGlobal("fetch", vi.fn());
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText },
		});
		writeText.mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("拒绝空表单并展示字段级错误", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);
		const submit = screen.getByRole("button", { name: "提交上架" });
		await waitFor(() => expect(submit).toBeEnabled());
		expect(submit).toHaveAttribute("form", "agent-registration-form");
		expect(screen.getAllByRole("button", { name: "提交上架" })).toHaveLength(1);
		fireEvent.click(submit);

		expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
		const nameInput = screen.getByLabelText("Agent 名称");
		expect(nameInput).toHaveAttribute("aria-invalid", "true");
		await waitFor(() => expect(nameInput).toHaveFocus());
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("未连接钱包时先触发连接，不提交空表单", async () => {
		walletMock.status = "disconnected";
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		const connect = await screen.findByRole("button", {
			name: "连接钱包后提交",
		});
		await waitFor(() => expect(connect).toBeEnabled());
		fireEvent.click(connect);

		expect(walletMock.connect).toHaveBeenCalledOnce();
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(screen.queryByText("请检查输入内容")).not.toBeInTheDocument();
	});

	it("在一个页面完成上架，默认填入登录钱包并允许修改收款地址", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		expect(await screen.findByLabelText("Agent 名称")).toBeInTheDocument();
		expect(screen.queryByText("第 1 步，共 2 步")).not.toBeInTheDocument();
		expect(screen.getByText("市场资料")).toBeInTheDocument();
		expect(
			await screen.findByRole("combobox", { name: "服务分类" }),
		).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "技能标签" })).toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "技能标签" })).toHaveAttribute(
			"placeholder",
			"输入自定义标签，按回车添加",
		);
		expect(screen.getByLabelText("收款钱包")).toHaveValue(CONNECTED_WALLET);
		expect(screen.getByLabelText("单次服务报价（USDC）")).toHaveValue("");
		expect(screen.getByLabelText("单次服务报价（USDC）")).toHaveAttribute(
			"placeholder",
			"例如：25",
		);
		expect(screen.queryByText("AICP v1")).not.toBeInTheDocument();
		expect(
			screen.getByText("提交后，平台将自动检查服务连通性和接入要求。"),
		).toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("收款钱包"), {
			target: { value: PAYOUT_WALLET },
		});
		expect(screen.getByLabelText("收款钱包")).toHaveValue(PAYOUT_WALLET);
	});

	it("允许在平台推荐标签之外添加、规范化并移除自定义标签", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		const input = await screen.findByRole("textbox", { name: "技能标签" });
		fireEvent.change(input, { target: { value: "  RAG   Workflow  " } });
		fireEvent.keyDown(input, { key: "Enter" });

		const remove = screen.getByRole("button", {
			name: "移除标签 rag workflow",
		});
		expect(remove).toBeInTheDocument();
		expect(screen.getByText("已选择 1/10")).toBeInTheDocument();
		fireEvent.click(remove);
		expect(
			screen.queryByRole("button", { name: "移除标签 rag workflow" }),
		).not.toBeInTheDocument();
	});

	it("展示并复制可直接运行的 TypeScript AICP 接入模板", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		fireEvent.click(screen.getByRole("button", { name: "查看接入示例" }));

		const dialog = screen.getByRole("dialog", {
			name: "可直接使用的 AICP 接入模板",
		});
		expect(dialog).toHaveTextContent("createServer");
		expect(dialog).toHaveTextContent("/healthz");
		expect(dialog).toHaveTextContent("Idempotency-Key");
		expect(dialog).toHaveTextContent("X-Signature");

		fireEvent.click(screen.getByRole("button", { name: "复制完整代码" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0]?.[0]).toContain("createHmac");
		expect(
			screen.getByRole("button", { name: "代码已复制" }),
		).toBeInTheDocument();
	});

	it("提交成功后清空凭证并链接到正式编辑页", async () => {
		mockTaxonomyResponses();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({ agentId: "agent-123", status: "pending_review" }),
				{
					status: 201,
					headers: { "content-type": "application/json" },
				},
			),
		);

		render(<AgentRegistrationForm />);
		await fillValidForm();
		fireEvent.click(screen.getByRole("button", { name: "提交上架" }));

		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"提交成功，等待平台验证",
			),
		);
		expect(fetch).toHaveBeenLastCalledWith(
			"https://business-api.test/api/agents",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"tags":["next.js"]'),
			}),
		);
		const request = vi.mocked(fetch).mock.calls.at(-1)?.[1];
		expect(request?.body).toEqual(
			expect.stringContaining('"amount":"12000000"'),
		);
		expect(request?.body).toEqual(
			expect.stringContaining(`"walletAddress":"${CONNECTED_WALLET}"`),
		);
		expect(request?.body).toEqual(
			expect.stringContaining(`"payoutWalletAddress":"${PAYOUT_WALLET}"`),
		);
		expect(screen.getByRole("link", { name: "继续配置" })).toHaveAttribute(
			"href",
			"/agents/agent-123/edit",
		);
		expect(screen.getByLabelText("访问密钥")).toHaveValue("");
	});

	it("将服务端嵌套报价错误映射到报价输入项", async () => {
		mockTaxonomyResponses();
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error_code: "VALIDATION_FAILED",
					message: "请求字段校验失败",
					retryable: false,
					fields: [{ field: "price.amount", message: "报价超出允许范围" }],
				}),
				{ status: 422, headers: { "content-type": "application/json" } },
			),
		);

		render(<AgentRegistrationForm />);
		await fillValidForm();
		fireEvent.click(screen.getByRole("button", { name: "提交上架" }));

		expect(await screen.findByText("报价超出允许范围")).toBeInTheDocument();
	});
});
