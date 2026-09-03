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

function mockTaxonomyResponses() {
	vi.mocked(fetch).mockResolvedValueOnce(categoryResponse());
}

async function fillValidForm(options: { withCredential?: boolean } = {}) {
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
	if (options.withCredential !== false) {
		fireEvent.change(screen.getByLabelText("访问密钥"), {
			target: { value: "secret" },
		});
	}
	fireEvent.change(screen.getByLabelText("单次服务报价（USDC）"), {
		target: { value: "12" },
	});
	fireEvent.change(screen.getByLabelText("收款钱包"), {
		target: { value: PAYOUT_WALLET },
	});
	const category = screen.getByRole("combobox", { name: "服务分类" });
	fireEvent.click(category);
	const categoryOption = await screen.findByRole("option", {
		name: "软件与网站开发",
	});
	fireEvent.pointerDown(categoryOption, { pointerType: "mouse" });
	fireEvent.click(categoryOption);
	const tagInput = screen.getByRole("textbox", { name: "技能标签" });
	fireEvent.change(tagInput, { target: { value: "next.js" } });
	fireEvent.keyDown(tagInput, { key: "Enter" });
}

function connectionSuccessResponse(latencyMs = 18) {
	return new Response(JSON.stringify({ status: "connected", latencyMs }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

async function verifyConnection() {
	fireEvent.click(screen.getByRole("button", { name: "测试连接" }));
	await waitFor(() =>
		expect(screen.getByText(/连接成功，响应耗时/)).toBeInTheDocument(),
	);
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
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("测试空地址时只在输入框附近展示一次错误", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		fireEvent.click(screen.getByRole("button", { name: "测试连接" }));

		const endpoint = screen.getByLabelText("Agent 执行地址");
		expect(endpoint).toHaveAttribute("aria-invalid", "true");
		expect(screen.getAllByText("Agent 执行地址不能为空")).toHaveLength(1);
		expect(
			screen.queryByText("填写完成后测试连接，确认平台可以访问你的 Agent。"),
		).not.toBeInTheDocument();
		await waitFor(() => expect(endpoint).toHaveFocus());
	});

	it("不收集联系邮箱，避免把未启用的通知能力变成上架门槛", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		await screen.findByLabelText("Agent 名称");
		expect(screen.queryByLabelText("联系邮箱")).not.toBeInTheDocument();
		expect(screen.queryByText(/异常通知/)).not.toBeInTheDocument();
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
		expect(fetch).toHaveBeenCalledOnce();
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
		const sectionHeadings = screen
			.getAllByRole("heading")
			.map((heading) => heading.textContent);
		expect(sectionHeadings.indexOf("交付案例")).toBeGreaterThan(
			sectionHeadings.indexOf("报价与收款"),
		);
		const optionalBadges = screen.getAllByText("可选");
		expect(optionalBadges).toHaveLength(2);
		expect(new Set(optionalBadges.map((badge) => badge.className)).size).toBe(
			1,
		);
		expect(screen.queryByText("完全可选，可跳过")).not.toBeInTheDocument();
		expect(screen.queryByText("AICP v1")).not.toBeInTheDocument();
		expect(
			screen.getByText(
				"连接测试通过后即可提交；平台上架后会持续记录服务运行状态。",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"公开 Agent 可以留空；填写后会加密保存，提交后不再显示明文。",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("凭证安全")).not.toBeInTheDocument();
		expect(screen.queryByText("上架前只需准备三样")).not.toBeInTheDocument();
		expect(
			screen.queryByText(
				"你的报价是发布者看到的成交金额；平台服务费仅在成功结算时从 Agent 收入中扣除，最终明细会在验收前展示。",
			),
		).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("收款钱包"), {
			target: { value: PAYOUT_WALLET },
		});
		expect(screen.getByLabelText("收款钱包")).toHaveValue(PAYOUT_WALLET);
	});

	it("允许添加、规范化并移除自定义标签", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		const input = await screen.findByRole("textbox", { name: "技能标签" });
		fireEvent.change(input, { target: { value: "  RAG   Workflow  " } });
		fireEvent.keyDown(input, { key: "Enter" });

		const remove = screen.getByRole("button", {
			name: "移除标签 rag workflow",
		});
		expect(remove).toBeInTheDocument();
		expect(screen.getByText("已添加 1/10")).toBeInTheDocument();
		fireEvent.click(remove);
		expect(
			screen.queryByRole("button", { name: "移除标签 rag workflow" }),
		).not.toBeInTheDocument();
	});

	it("中文输入法确认候选词时不会把未完成的拼音提前添加为标签", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		const input = await screen.findByRole("textbox", { name: "技能标签" });
		fireEvent.change(input, { target: { value: "dian shang" } });
		fireEvent.keyDown(input, {
			key: "Enter",
			code: "Enter",
			keyCode: 229,
			isComposing: true,
		});

		expect(input).toHaveValue("dian shang");
		expect(
			screen.queryByRole("button", { name: "移除标签 dian shang" }),
		).not.toBeInTheDocument();

		// 输入法完成“电商”上屏后，用户再次按普通回车才会真正添加标签。
		fireEvent.change(input, { target: { value: "电商" } });
		fireEvent.keyDown(input, {
			key: "Enter",
			code: "Enter",
			keyCode: 13,
			isComposing: false,
		});
		expect(
			screen.getByRole("button", { name: "移除标签 电商" }),
		).toBeInTheDocument();
	});

	it("只展示 HTTP 边界代码，不再要求提供者安装 SDK", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);

		fireEvent.click(screen.getByRole("button", { name: "查看接入示例" }));

		const dialog = screen.getByRole("dialog", {
			name: "快速接入你的 Agent",
		});
		expect(dialog).toHaveTextContent("HTTP API");
		expect(dialog).toHaveTextContent('app.post("/run"');
		expect(dialog).toHaveTextContent("myAgent.run");
		expect(dialog).not.toHaveTextContent("@aicp/agent-sdk");
		expect(dialog).not.toHaveTextContent("timingSafeEqual");
		expect(dialog).not.toHaveTextContent("Idempotency-Key");
		expect(dialog).not.toHaveTextContent("多实例");
		expect(dialog).not.toHaveTextContent("共享持久化");
		expect(screen.queryByRole("tab")).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "复制接入模板" }));
		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		expect(writeText.mock.calls[0]?.[0]).toContain('app.post("/run"');
		expect(writeText.mock.calls[0]?.[0]).not.toContain("createHmac");
		expect(
			screen.getByRole("button", { name: "代码已复制" }),
		).toBeInTheDocument();
	});

	it("提交成功后清空凭证并链接到正式编辑页", async () => {
		mockTaxonomyResponses();
		vi.mocked(fetch).mockResolvedValueOnce(connectionSuccessResponse());
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
		await verifyConnection();
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
		const requestBody = JSON.parse(String(request?.body)) as Record<
			string,
			unknown
		>;
		expect(requestBody).not.toHaveProperty("email");
		expect(request?.body).toEqual(
			expect.stringContaining('"amount":"12000000"'),
		);
		expect(request?.body).toEqual(
			expect.stringContaining(`"walletAddress":"${CONNECTED_WALLET}"`),
		);
		expect(request?.body).toEqual(
			expect.stringContaining(`"payoutWalletAddress":"${PAYOUT_WALLET}"`),
		);
		// 无案例是正常的首次上架路径，请求不发送空数组，也不会让服务端误判为缺失资料。
		expect(requestBody).not.toHaveProperty("portfolioCases");
		expect(screen.queryByText("公开案例")).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: "继续配置" })).toHaveAttribute(
			"href",
			"/agents/agent-123/edit",
		);
		expect(screen.getByLabelText("访问密钥")).toHaveValue("");
	});

	it("允许附带公开案例，并把案例作为 Agent 自提供证据提交", async () => {
		mockTaxonomyResponses();
		vi.mocked(fetch).mockResolvedValueOnce(connectionSuccessResponse());
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({ agentId: "agent-case", status: "pending_review" }),
				{ status: 201, headers: { "content-type": "application/json" } },
			),
		);
		render(<AgentRegistrationForm />);
		await fillValidForm();
		await verifyConnection();

		fireEvent.click(screen.getByRole("button", { name: "添加案例" }));
		fireEvent.change(screen.getByLabelText("案例标题"), {
			target: { value: "电商营销首页" },
		});
		fireEvent.change(screen.getByLabelText("公开预览地址"), {
			target: { value: "https://example.com/storefront" },
		});
		fireEvent.change(screen.getByLabelText("案例说明"), {
			target: { value: "展示完整视觉设计与可访问页面。" },
		});
		fireEvent.click(screen.getByRole("button", { name: "提交上架" }));

		await screen.findByRole("status");
		const requestBody = String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body);
		expect(JSON.parse(requestBody)).toMatchObject({
			portfolioCases: [
				{
					title: "电商营销首页",
					summary: "展示完整视觉设计与可访问页面。",
					artifactKind: "website",
					previewRef: "https://example.com/storefront",
				},
			],
		});
	});

	it("将服务端嵌套报价错误映射到报价输入项", async () => {
		mockTaxonomyResponses();
		vi.mocked(fetch).mockResolvedValueOnce(connectionSuccessResponse());
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
		await verifyConnection();
		fireEvent.click(screen.getByRole("button", { name: "提交上架" }));

		expect(await screen.findByText("报价超出允许范围")).toBeInTheDocument();
	});

	it("公开 Agent 不填写访问密钥也能测试并提交", async () => {
		mockTaxonomyResponses();
		vi.mocked(fetch).mockResolvedValueOnce(connectionSuccessResponse(9));
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({ agentId: "public-agent", status: "pending_review" }),
				{ status: 201, headers: { "content-type": "application/json" } },
			),
		);
		render(<AgentRegistrationForm />);
		await fillValidForm({ withCredential: false });

		await verifyConnection();
		const connectionBody = JSON.parse(
			String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body),
		);
		expect(connectionBody).not.toHaveProperty("credentialSecret");
		fireEvent.click(screen.getByRole("button", { name: "提交上架" }));

		await waitFor(() =>
			expect(screen.getByText("继续配置")).toBeInTheDocument(),
		);
		const registrationBody = JSON.parse(
			String(vi.mocked(fetch).mock.calls.at(-1)?.[1]?.body),
		);
		expect(registrationBody).toMatchObject({ integrationMode: "http_json" });
		expect(registrationBody).not.toHaveProperty("credentialSecret");
	});

	it("执行地址变化后清除旧连接结果并要求重新测试", async () => {
		mockTaxonomyResponses();
		vi.mocked(fetch).mockResolvedValueOnce(connectionSuccessResponse());
		render(<AgentRegistrationForm />);
		await fillValidForm();
		await verifyConnection();

		fireEvent.change(screen.getByLabelText("Agent 执行地址"), {
			target: { value: "https://agent-two.example.com/run" },
		});

		expect(screen.getByText("尚未测试")).toBeInTheDocument();
		expect(
			screen.getByText("填写完成后测试连接，确认平台可以访问你的 Agent。"),
		).toBeInTheDocument();
	});

	it("完整资料未测试连接时不发送上架请求，并聚焦测试按钮", async () => {
		mockTaxonomyResponses();
		render(<AgentRegistrationForm />);
		await fillValidForm();

		fireEvent.click(screen.getByRole("button", { name: "提交上架" }));

		expect(
			await screen.findByText("请先测试 Agent 连接，确认服务可用后再提交"),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "测试连接" })).toHaveFocus(),
		);
		// 唯一一次请求来自分类加载，说明连接测试门禁没有误发正式注册请求。
		expect(fetch).toHaveBeenCalledTimes(1);
	});
});
