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
	};
});

/** 模拟用户明确选择匹配分类，避免测试依赖静默默认值。 */
async function selectProductCategory() {
	const category = await screen.findByRole("combobox", { name: "服务分类" });
	fireEvent.click(category);
	const categoryOption = await screen.findByRole("option", {
		name: "软件与网站开发",
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
			status: "planning",
			statusVersion: "2",
			planning: {
				estimatedBudgetMinor: null,
				message: "工作流已生成，请先选择 Agent",
			},
		});
	});

	afterEach(() => cleanup());

	it("keeps only user-facing requirement and matching inputs with no demo content", async () => {
		render(<NewTaskForm />);

		const pageTitle = screen.getByRole("heading", { name: "发布你的需求" });
		expect(pageTitle).toBeInTheDocument();
		// 页面主标题遵循全站 Hero 规范，只突出核心动作对象，不把整句话全部着色。
		expect(pageTitle.querySelector(".brand-text")).toHaveTextContent("需求");
		expect(
			screen.getByText("告诉我们你想完成什么，平台会为你推荐合适的 Agent。"),
		).toBeInTheDocument();
		expect(screen.queryByText("可验证任务")).not.toBeInTheDocument();
		expect(screen.queryByText(/正式草稿|服务端校验/)).not.toBeInTheDocument();
		expect(screen.getByLabelText("任务标题")).toHaveValue("");
		expect(screen.getByLabelText("补充说明（可选）")).toHaveValue("");
		expect(screen.queryByLabelText("固定预算")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("group", { name: "技能标签" }),
		).not.toBeInTheDocument();
		expect(screen.queryByText("预算外平台费用")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "截止时间" })).toHaveTextContent(
			"请选择截止日期",
		);
		const deadlineHint = screen.getByText("所选日期当天结束前均可交付");
		expect(deadlineHint).toHaveClass("text-muted-foreground", "text-xs");
		expect(deadlineHint.closest(".bg-warning\\/10")).toBeNull();
		expect(
			await screen.findByRole("combobox", { name: "服务分类" }),
		).toBeInTheDocument();
		expect(screen.getByText("发布后推荐执行方案")).toBeInTheDocument();
		expect(screen.queryByText("平台推荐")).not.toBeInTheDocument();
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
		expect(
			screen.queryByRole("group", { name: "技能标签" }),
		).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("combobox", { name: "服务分类" }));
		expect(
			await screen.findByRole("option", { name: "软件与网站开发" }),
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
		const publish = screen.getByRole("button", { name: /发布并选择 Agent/ });
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

	// 该用例覆盖分类异步加载、标签合成、两次正式 API 调用和路由跳转；全套并发运行时
	// 默认 5 秒会把正常完成误判为失败。单独放宽到 10 秒，不删除任何行为断言。
	it("publishes from the essential inputs while preserving the API contract", async () => {
		render(<NewTaskForm />);
		const title = "开发跨境电商后台管理系统";
		const request =
			"使用 Next.js 开发一个跨境电商后台，让运营人员管理商品、订单和团队权限，并提供必要测试。";
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: title },
		});
		fireEvent.change(screen.getByLabelText("补充说明（可选）"), {
			target: { value: request },
		});
		selectFutureDeadline();
		await selectProductCategory();

		const publish = screen.getByRole("button", { name: /发布并选择 Agent/ });
		await waitFor(() => expect(publish).toBeEnabled());
		fireEvent.click(publish);

		await waitFor(() => expect(mocks.createTaskDraft).toHaveBeenCalledOnce());
		const input = mocks.createTaskDraft.mock.calls[0]?.[0];
		expect(input).toMatchObject({
			title,
			description: request,
			categoryId: "40000000-0000-4000-8000-000000000023",
			tags: [],
			currency: "USDC",
		});
		expect(input).not.toHaveProperty("pricing");
		// 未直接展示的字段仍从正文、分类和标签可追溯地整理，不要求用户二次填写。
		expect(input.acceptanceCriteria.length).toBeGreaterThanOrEqual(10);
		expect(input.deliverableFormat).not.toBe("");
		expect(input.requiredCapability).toBe("软件开发");
		expect(mocks.submitTask).toHaveBeenCalledWith(
			"50000000-0000-4000-8000-000000000001",
			expect.any(String),
		);
		expect(mocks.push).toHaveBeenCalledWith(
			"/tasks/50000000-0000-4000-8000-000000000001",
		);
	}, 10_000);

	it("具体标题可直接作为执行输入，不展示额外的自由发挥选项", async () => {
		render(<NewTaskForm />);
		const title = "开发一个内容网站";
		expect(
			screen.queryByRole("checkbox", {
				name: "未指定的风格与呈现细节，交给 Agent 发挥",
			}),
		).not.toBeInTheDocument();
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: title },
		});
		selectFutureDeadline();
		await selectProductCategory();

		const publish = screen.getByRole("button", { name: /发布并选择 Agent/ });
		await waitFor(() => expect(publish).toBeEnabled());
		fireEvent.click(publish);

		await waitFor(() => expect(mocks.createTaskDraft).toHaveBeenCalledOnce());
		expect(mocks.createTaskDraft.mock.calls[0]?.[0]).toMatchObject({
			title,
			description: title,
			tags: [],
			requiredCapability: "软件开发",
		});
	});

	// 只拦截明确没有执行对象的请求，不把“详细需求选填”偷偷改成长篇必填。
	it("缺少主题时就近提示，补充主题后仅提交用户填写的说明", async () => {
		render(<NewTaskForm />);
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: "设计一个海报" },
		});
		selectFutureDeadline();
		await selectProductCategory();
		fireEvent.click(screen.getByRole("button", { name: /发布并选择 Agent/ }));
		expect(mocks.createTaskDraft).not.toHaveBeenCalled();
		expect(screen.getByLabelText("补充说明（可选）")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		fireEvent.change(screen.getByLabelText("补充说明（可选）"), {
			target: { value: "为夏季促销设计" },
		});
		fireEvent.click(screen.getByRole("button", { name: /发布并选择 Agent/ }));
		await waitFor(() => expect(mocks.createTaskDraft).toHaveBeenCalledOnce());
		expect(mocks.createTaskDraft.mock.calls[0]?.[0].description).toBe(
			"为夏季促销设计",
		);
	});

	it("不要求用户填写预算或技能标签也可以发布需求", async () => {
		render(<NewTaskForm />);
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: "开发一个内容网站" },
		});
		selectFutureDeadline();
		await selectProductCategory();

		fireEvent.click(screen.getByRole("button", { name: /发布并选择 Agent/ }));
		await waitFor(() => expect(mocks.createTaskDraft).toHaveBeenCalledOnce());
		expect(mocks.createTaskDraft.mock.calls[0]?.[0]).toMatchObject({
			tags: [],
		});
	});

	it("第一步完全不展示会被误解为最终扣款的金额输入", async () => {
		render(<NewTaskForm />);
		expect(screen.queryByText("任务预算")).not.toBeInTheDocument();
		expect(screen.queryByText("固定预算")).not.toBeInTheDocument();
		expect(
			screen.getByText("选择 Agent 后确认报价并托管 USDC"),
		).toBeInTheDocument();
	});

	it("用简短信息说明发布后的自动执行流程", async () => {
		render(<NewTaskForm />);
		expect(screen.getByText("执行流程")).toBeInTheDocument();
		expect(screen.getByText("发布后推荐执行方案")).toBeInTheDocument();
		expect(screen.queryByText("发布保障")).not.toBeInTheDocument();
		expect(
			screen.queryByText(
				"发布后平台先拆分工作流并推荐各阶段 Agent。全部选完后会计算准确总价，再由你确认 USDC 托管；资金确认前不会派发任务。",
			),
		).not.toBeInTheDocument();
	});

	it("需求预览不提前展示伪造的任务金额", async () => {
		render(<NewTaskForm />);
		expect(screen.queryByText(/0 USDC|50 USDC/)).not.toBeInTheDocument();
	});

	it("keeps automatic execution as the product default without exposing workflow internals", () => {
		render(<NewTaskForm />);

		fireEvent.click(screen.getByRole("button", { name: "展开高级设置" }));

		expect(screen.queryByText("自动分配规则")).not.toBeInTheDocument();
		expect(screen.queryByText("排序依据")).not.toBeInTheDocument();
		expect(screen.queryByText("价格上限")).not.toBeInTheDocument();
		expect(screen.queryByText("失败回退")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("radio", { name: /平台自动分配/ }),
		).not.toBeInTheDocument();
		expect(
			screen.getByText("平台自动执行完整流程，最终交付由你验收"),
		).toBeInTheDocument();
	});

	it("always submits the automatic assignment contract without another user choice", async () => {
		render(<NewTaskForm />);
		fireEvent.change(screen.getByLabelText("任务标题"), {
			target: { value: "开发团队项目管理后台" },
		});
		fireEvent.change(screen.getByLabelText("补充说明（可选）"), {
			target: {
				value:
					"开发一个团队项目管理后台，支持任务分配、进度查看和成员权限，并提供完整测试与使用说明。",
			},
		});
		selectFutureDeadline();
		await selectProductCategory();

		fireEvent.click(screen.getByRole("button", { name: /发布并选择 Agent/ }));
		await waitFor(() => expect(mocks.createTaskDraft).toHaveBeenCalledOnce());
		expect(mocks.createTaskDraft.mock.calls[0]?.[0]).toMatchObject({
			assignmentMode: { mode: "manual" },
			acceptanceMode: { mode: "manual" },
		});
	});

	it("explains that only the final delivery requires publisher acceptance", () => {
		render(<NewTaskForm />);

		expect(screen.getByText("最终交付由你确认")).toBeInTheDocument();
		expect(
			screen.queryByRole("radio", { name: /规则自动验收/ }),
		).not.toBeInTheDocument();
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
