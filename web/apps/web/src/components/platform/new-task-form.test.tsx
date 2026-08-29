import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import NewTaskForm from "./new-task-form";

const mocks = vi.hoisted(() => ({
	createTaskDraft: vi.fn(),
	submitTask: vi.fn(),
	suggestTaskTags: vi.fn(),
	push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: mocks.push }),
}));
vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({
		status: "connected",
		walletAddress: "0x1111111111111111111111111111111111111111",
		error: null,
		connect: vi.fn(),
	}),
}));
vi.mock("@/lib/api/tasks", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
	return {
		...actual,
		createTaskDraft: mocks.createTaskDraft,
		submitTask: mocks.submitTask,
		listTaskCategories: vi.fn(async () => [
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
		]),
		suggestTaskTags: mocks.suggestTaskTags,
	};
});

/** 模拟用户明确选择匹配分类，避免测试依赖静默默认值。 */
async function selectProductCategory() {
	const category = await screen.findByRole("combobox", { name: "服务分类" });
	fireEvent.click(category);
	const categoryOption = await screen.findByRole("option", {
		name: "代码开发",
	});
	fireEvent.pointerDown(categoryOption, { pointerType: "mouse" });
	fireEvent.click(categoryOption);
}

describe("New task assignment mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.createTaskDraft.mockResolvedValue({
			taskId: "50000000-0000-4000-8000-000000000001",
			status: "draft",
			statusVersion: "1",
			visibility: "public",
		});
		mocks.submitTask.mockResolvedValue({
			taskId: "50000000-0000-4000-8000-000000000001",
			status: "awaiting_escrow",
			statusVersion: "2",
			preview: {
				escrowAmountMinor: "12800000",
				platformFeeMinor: "51200",
				agentReceivesMinor: "12748800",
				feeBasisPoints: "40",
				minimumPlatformFeeMinor: "50000",
				feeRuleVersion: "fee-v3-usdc",
				irreversibleWarning: "链上托管确认后只能按状态机释放资金",
			},
		});
		// 返回真实接口形状的受控标签，用来确认页面只采用正文中明确出现的标签。
		mocks.suggestTaskTags.mockResolvedValue([
			{ canonicalName: "next.js", matchedAlias: null },
			{ canonicalName: "agent", matchedAlias: null },
			{ canonicalName: "typescript", matchedAlias: null },
			{ canonicalName: "ui/ux", matchedAlias: null },
			{ canonicalName: "mastra", matchedAlias: null },
		]);
	});

	afterEach(() => cleanup());

	it("keeps only user-facing requirement and matching inputs with no demo content", async () => {
		render(<NewTaskForm />);

		expect(
			screen.getByRole("heading", { name: "发布你的需求" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("告诉我们你想完成什么，平台会为你推荐合适的 Agent。"),
		).toBeInTheDocument();
		expect(screen.queryByText("可验证任务")).not.toBeInTheDocument();
		expect(screen.queryByText(/正式草稿|服务端校验/)).not.toBeInTheDocument();
		expect(screen.getByLabelText("任务标题")).toHaveValue("");
		expect(screen.getByLabelText("详细需求")).toHaveValue("");
		expect(screen.getByLabelText("固定预算")).toHaveValue("");
		expect(screen.getByLabelText("固定预算")).toHaveAttribute(
			"placeholder",
			"例如：50",
		);
		expect(screen.getByText("预算外平台费用")).toBeInTheDocument();
		expect(screen.getByText("0 USDC")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "截止时间" })).toHaveTextContent(
			"请选择截止日期",
		);
		expect(
			await screen.findByRole("combobox", { name: "服务分类" }),
		).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "技能标签" })).toBeInTheDocument();
		expect(
			screen.queryByRole("radio", { name: /平台自动分配/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByDisplayValue(/可信的 AI Agent/),
		).not.toBeInTheDocument();
	});

	it("keeps matching fields visible without restoring the internal task contract", async () => {
		render(<NewTaskForm />);

		expect(screen.queryByText("结构化任务合同")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "展开结构化任务合同" }),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("任务标题")).toBeInTheDocument();
		expect(
			await screen.findByRole("combobox", { name: "服务分类" }),
		).toBeInTheDocument();
		expect(screen.getByRole("group", { name: "技能标签" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("combobox", { name: "服务分类" }));
		expect(
			await screen.findByRole("option", { name: "代码开发" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("option", { name: "产品与开发" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByText(/产品与开发 \/ 软件开发/),
		).not.toBeInTheDocument();
		expect(screen.queryByLabelText("验收标准")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("交付格式")).not.toBeInTheDocument();
		expect(screen.queryByLabelText("所需能力")).not.toBeInTheDocument();
	});

	it("提交空表单时立即定位到第一个错误字段", async () => {
		render(<NewTaskForm />);
		const publish = screen.getByRole("button", { name: /发布并继续托管/ });
		await waitFor(() => expect(publish).toBeEnabled());
		fireEvent.click(publish);

		const title = screen.getByLabelText("任务标题");
		expect(title).toHaveAttribute("aria-invalid", "true");
		expect(document.getElementById("task-title-error")).toHaveTextContent(
			"请输入 6–72 个字符的任务标题",
		);
		await waitFor(() => expect(title).toHaveFocus());
		expect(mocks.createTaskDraft).not.toHaveBeenCalled();
	});

	it("publishes from the essential inputs while preserving the API contract", async () => {
		render(<NewTaskForm />);
		const title = "开发跨境电商后台管理系统";
		const request =
			"使用 Next.js 开发一个跨境电商后台，让运营人员管理商品、订单和团队权限，并提供必要测试。";
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: title },
		});
		fireEvent.change(screen.getByLabelText("详细需求"), {
			target: { value: request },
		});
		fireEvent.change(screen.getByLabelText("固定预算"), {
			target: { value: "12.8" },
		});
		selectFutureDeadline();
		await selectProductCategory();
		fireEvent.click(await screen.findByRole("button", { name: "next.js" }));

		const publish = screen.getByRole("button", { name: /发布并继续托管/ });
		await waitFor(() => expect(publish).toBeEnabled());
		fireEvent.click(publish);

		await waitFor(() => expect(mocks.createTaskDraft).toHaveBeenCalledOnce());
		const input = mocks.createTaskDraft.mock.calls[0]?.[0];
		expect(input).toMatchObject({
			title,
			description: request,
			categoryId: "40000000-0000-4000-8000-000000000023",
			tags: ["next.js"],
			pricing: { type: "fixed", amountMinor: "12800000" },
			currency: "USDC",
		});
		// 未直接展示的字段仍从正文、分类和标签可追溯地整理，不要求用户二次填写。
		expect(input.acceptanceCriteria.length).toBeGreaterThanOrEqual(10);
		expect(input.deliverableFormat).not.toBe("");
		expect(input.requiredCapability).toBe("next.js");
		expect(mocks.submitTask).toHaveBeenCalledWith(
			"50000000-0000-4000-8000-000000000001",
			expect.any(String),
		);
		expect(mocks.push).toHaveBeenCalledWith(
			"/tasks/50000000-0000-4000-8000-000000000001",
		);
	});

	it("asks for a clearer request instead of fabricating content to satisfy validation", async () => {
		render(<NewTaskForm />);
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: "开发一个内容网站" },
		});
		fireEvent.change(screen.getByLabelText("详细需求"), {
			target: { value: "帮我开发一个网站" },
		});
		fireEvent.change(screen.getByLabelText("固定预算"), {
			target: { value: "0.01" },
		});
		selectFutureDeadline();
		await selectProductCategory();

		const publish = screen.getByRole("button", { name: /发布并继续托管/ });
		await waitFor(() => expect(publish).toBeEnabled());
		fireEvent.click(publish);

		expect(
			await screen.findByText(
				"请至少用 30 个字符描述目标、使用场景和必须满足的限制",
			),
		).toBeInTheDocument();
		expect(mocks.createTaskDraft).not.toHaveBeenCalled();
	});

	it("在请求服务端前拒绝低于 1 USDC 的任务预算", async () => {
		render(<NewTaskForm />);
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: "开发团队运营数据后台" },
		});
		fireEvent.change(screen.getByLabelText("详细需求"), {
			target: {
				value:
					"开发团队运营数据后台，支持成员权限、任务统计和交付验收，并提供自动化测试与使用说明。",
			},
		});
		fireEvent.change(screen.getByLabelText("固定预算"), {
			target: { value: "0.99" },
		});
		selectFutureDeadline();
		await selectProductCategory();
		fireEvent.click(await screen.findByRole("button", { name: "next.js" }));

		fireEvent.click(screen.getByRole("button", { name: /发布并继续托管/ }));

		expect(
			await screen.findByText(
				"任务预算须在 1–100,000 USDC 之间，最多保留 6 位小数",
			),
		).toBeInTheDocument();
		expect(mocks.createTaskDraft).not.toHaveBeenCalled();
	});

	it("accepts a normalized custom tag even when no platform suggestion is available", async () => {
		mocks.suggestTaskTags.mockResolvedValue([]);
		render(<NewTaskForm />);
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: "制作内容运营工作台" },
		});
		fireEvent.change(screen.getByLabelText("详细需求"), {
			target: {
				value:
					"为内容团队制作一套清晰易用的运营工作台，需要支持日常数据查看、权限控制和结果验收。",
			},
		});
		fireEvent.change(screen.getByLabelText("固定预算"), {
			target: { value: "50" },
		});
		selectFutureDeadline();
		await selectProductCategory();
		const customTagInput = screen.getByRole("textbox", { name: "技能标签" });
		fireEvent.change(customTagInput, {
			target: { value: "  RAG   Workflow  " },
		});
		fireEvent.keyDown(customTagInput, { key: "Enter" });
		expect(
			screen.getByRole("button", { name: "移除标签 rag workflow" }),
		).toBeInTheDocument();

		const publish = screen.getByRole("button", { name: /发布并继续托管/ });
		await waitFor(() => expect(publish).toBeEnabled());
		fireEvent.click(publish);

		await waitFor(() => expect(mocks.createTaskDraft).toHaveBeenCalledOnce());
		expect(mocks.createTaskDraft.mock.calls[0]?.[0]).toMatchObject({
			tags: ["rag workflow"],
		});
	});

	it("keeps the preview compact and reveals how many selected tags are hidden", async () => {
		render(<NewTaskForm />);

		for (const tag of ["next.js", "agent", "typescript", "ui/ux", "mastra"]) {
			fireEvent.click(await screen.findByRole("button", { name: tag }));
		}

		const overflow = screen.getByLabelText("另有 1 个技能标签");
		expect(overflow).toBeInTheDocument();
		expect(overflow).toHaveTextContent("+1");
	});

	it("keeps automatic execution as the product default without exposing workflow internals", () => {
		render(<NewTaskForm />);

		fireEvent.click(screen.getByRole("button", { name: "展开高级设置" }));

		expect(screen.queryByText("自动分配规则")).not.toBeInTheDocument();
		expect(screen.queryByText("排序依据")).not.toBeInTheDocument();
		expect(screen.queryByText("价格上限")).not.toBeInTheDocument();
		expect(screen.queryByText("失败回退")).not.toBeInTheDocument();
		expect(screen.queryByRole("radio", { name: /平台自动分配/ })).not.toBeInTheDocument();
		expect(screen.getByText("平台自动执行完整流程，最终交付由你验收")).toBeInTheDocument();
	});

	it("always submits the automatic assignment contract without another user choice", async () => {
		render(<NewTaskForm />);
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: "开发团队项目管理后台" },
		});
		fireEvent.change(screen.getByLabelText("详细需求"), {
			target: {
				value:
					"开发一个团队项目管理后台，支持任务分配、进度查看和成员权限，并提供完整测试与使用说明。",
			},
		});
		fireEvent.change(screen.getByLabelText("固定预算"), {
			target: { value: "12.8" },
		});
		selectFutureDeadline();
		await selectProductCategory();
		fireEvent.click(await screen.findByRole("button", { name: "next.js" }));

		fireEvent.click(screen.getByRole("button", { name: /发布并继续托管/ }));
		await waitFor(() => expect(mocks.createTaskDraft).toHaveBeenCalledOnce());
		expect(mocks.createTaskDraft.mock.calls[0]?.[0]).toMatchObject({
			assignmentMode: {
				mode: "automatic",
				priceCapMinor: "12800000",
				rankingBasis: "active-ranking-rule",
				fallbackOnFail: "manual",
			},
			acceptanceMode: { mode: "manual" },
		});
	});

	it("explains that only the final delivery requires publisher acceptance", () => {
		render(<NewTaskForm />);

		expect(screen.getByText("中间阶段自动推进，最终交付由你验收")).toBeInTheDocument();
		expect(screen.queryByRole("radio", { name: /规则自动验收/ })).not.toBeInTheDocument();
	});
});

/**
 * 表单测试只关心选择器能向父表单提交合法值；具体月历切换、时间和关闭行为由
 * DateTimePicker 自己的组件测试覆盖，避免每个业务表单重复耦合月历内部结构。
 */
function selectFutureDeadline() {
	fireEvent.click(screen.getByRole("button", { name: "截止时间" }));
	fireEvent.click(screen.getByRole("button", { name: "下个月" }));
	const availableDays = screen.getAllByRole("button", {
		name: /选择 \d{4}年\d{1,2}月\d{1,2}日/,
	});
	fireEvent.click(availableDays.at(-1) as HTMLButtonElement);
	fireEvent.click(screen.getByRole("button", { name: "确认截止日期" }));
}
