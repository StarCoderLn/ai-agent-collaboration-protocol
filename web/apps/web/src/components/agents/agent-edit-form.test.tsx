import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@/lib/api/agents";
import AgentEditForm from "./agent-edit-form";

const baseAgent: Agent = {
	id: "agent-123",
	providerWalletAddress: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
	name: "Translator Agent",
	categoryId: "3f9e2c2e-6b2a-4f0e-9c1a-2f7a5b6c8d9e",
	capabilityDesc: "中英互译",
	tags: ["翻译"],
	pricingType: "per_task",
	priceAmount: "1000000",
	priceCurrency: "USDC",
	serviceEndpoint: "https://agent.example.com/run",
	email: "provider@example.com",
	status: "active",
	pauseReason: null,
	createdAt: "2026-08-20T00:00:00.000Z",
	updatedAt: "2026-08-20T00:00:00.000Z",
};

describe("AgentEditForm", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("钱包地址字段只读展示，不可编辑", () => {
		render(<AgentEditForm agent={baseAgent} onSaved={vi.fn()} />);
		const walletInput = screen.getByLabelText("钱包地址");
		expect(walletInput).toBeDisabled();
		expect(walletInput).toHaveValue(baseAgent.providerWalletAddress);
		expect(screen.getByLabelText("单次服务报价（USDC）")).toHaveValue("1");
		expect(screen.getByLabelText("币种")).toBeDisabled();
	});

	it("以可读 USDC 编辑报价，并在 PATCH 时无损转换为最小单位", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ ...baseAgent, priceAmount: "25500000" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		render(<AgentEditForm agent={baseAgent} onSaved={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("单次服务报价（USDC）"), {
			target: { value: "25.5" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

		await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
		expect(fetch).toHaveBeenCalledWith(
			"https://business-api.test/api/agents/agent-123",
			expect.objectContaining({
				body: JSON.stringify({ priceAmount: "25500000" }),
			}),
		);
	});

	it("提交非法邮箱格式时展示字段级错误，且不发起请求", async () => {
		render(<AgentEditForm agent={baseAgent} onSaved={vi.fn()} />);
		fireEvent.change(screen.getByLabelText("邮箱"), {
			target: { value: "not-an-email" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

		expect(await screen.findByText("邮箱格式非法")).toBeInTheDocument();
		const email = screen.getByLabelText("邮箱");
		expect(email).toHaveAttribute("aria-invalid", "true");
		expect(email).toHaveAttribute("aria-describedby", "email-error");
		await waitFor(() => expect(email).toHaveFocus());
		expect(fetch).not.toHaveBeenCalled();
	});

	it("只提交实际变化的字段（PATCH body 不含未变化字段）", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ ...baseAgent, email: "new@example.com" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		const onSaved = vi.fn();
		render(<AgentEditForm agent={baseAgent} onSaved={onSaved} />);

		fireEvent.change(screen.getByLabelText("邮箱"), {
			target: { value: "new@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(fetch).toHaveBeenCalledWith(
			"https://business-api.test/api/agents/agent-123",
			expect.objectContaining({
				method: "PATCH",
				body: JSON.stringify({ email: "new@example.com" }),
			}),
		);
	});

	it("将服务端字段级错误映射回对应输入项", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error_code: "VALIDATION_FAILED",
					message: "请求字段校验失败",
					retryable: false,
					fields: { email: "邮箱已被占用" },
				}),
				{ status: 422, headers: { "content-type": "application/json" } },
			),
		);
		render(<AgentEditForm agent={baseAgent} onSaved={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("邮箱"), {
			target: { value: "new@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

		expect(await screen.findByText("邮箱已被占用")).toBeInTheDocument();
	});

	it("网络失败时展示可读的失败提示", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network error"));
		render(<AgentEditForm agent={baseAgent} onSaved={vi.fn()} />);

		fireEvent.change(screen.getByLabelText("邮箱"), {
			target: { value: "new@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "保存修改" }));

		expect(await screen.findByText("保存失败，请稍后重试")).toBeInTheDocument();
	});
});
