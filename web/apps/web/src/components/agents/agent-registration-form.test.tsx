import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentRegistrationForm from "./agent-registration-form";

function fillValidForm() {
	fireEvent.change(screen.getByLabelText("名称"), {
		target: { value: "Translator Agent" },
	});
	fireEvent.change(screen.getByLabelText("分类 ID"), {
		target: { value: "3f9e2c2e-6b2a-4f0e-9c1a-2f7a5b6c8d9e" },
	});
	fireEvent.change(screen.getByLabelText("邮箱"), {
		target: { value: "provider@example.com" },
	});
	fireEvent.change(screen.getByLabelText("服务地址"), {
		target: { value: "https://agent.example.com/run" },
	});
	fireEvent.change(screen.getByLabelText("计价方式"), {
		target: { value: "per_task" },
	});
	fireEvent.change(screen.getByLabelText("报价（最小单位）"), {
		target: { value: "1000" },
	});
	fireEvent.change(screen.getByLabelText("币种"), {
		target: { value: "USDC" },
	});
	fireEvent.change(screen.getByLabelText("钱包地址"), {
		target: { value: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" },
	});
	fireEvent.change(screen.getByLabelText("能力描述"), {
		target: { value: "中英互译" },
	});
	fireEvent.change(screen.getByLabelText("标签（逗号分隔）"), {
		target: { value: "翻译" },
	});
	fireEvent.change(screen.getByLabelText("调用凭证"), {
		target: { value: "secret" },
	});
}

describe("AgentRegistrationForm", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("拒绝空表单并展示字段级错误", async () => {
		render(<AgentRegistrationForm />);
		fireEvent.click(screen.getByRole("button", { name: "提交注册" }));

		expect(await screen.findAllByRole("alert")).not.toHaveLength(0);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("提交成功后清空凭证并链接到正式编辑页", async () => {
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
		fillValidForm();
		fireEvent.click(screen.getByRole("button", { name: "提交注册" }));

		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("创建成功"),
		);
		expect(fetch).toHaveBeenCalledWith(
			"https://business-api.test/api/agents",
			expect.objectContaining({ method: "POST" }),
		);
		expect(screen.getByRole("link", { name: "继续配置" })).toHaveAttribute(
			"href",
			"/agents/agent-123/edit",
		);
		expect(screen.getByLabelText("调用凭证")).toHaveValue("");
	});

	it("将服务端嵌套报价错误映射到报价输入项", async () => {
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
		fillValidForm();
		fireEvent.click(screen.getByRole("button", { name: "提交注册" }));

		expect(await screen.findByText("报价超出允许范围")).toBeInTheDocument();
	});
});
