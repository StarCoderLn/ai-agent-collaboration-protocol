import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CredentialReplacePanel from "./credential-replace-panel";

describe("CredentialReplacePanel", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("提交前明文不可为空，空值不允许提交", () => {
		render(<CredentialReplacePanel agentId="agent-123" />);
		expect(screen.getByRole("button", { name: "替换凭证" })).toBeDisabled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("点击提交后立即清空本地明文状态（不等待网络响应）", async () => {
		let resolveFetch: (value: Response) => void = () => {};
		vi.mocked(fetch).mockReturnValueOnce(
			new Promise((resolve) => {
				resolveFetch = resolve;
			}),
		);

		render(<CredentialReplacePanel agentId="agent-123" />);
		const input = screen.getByLabelText("新认证配置");
		fireEvent.change(input, { target: { value: "top-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "替换凭证" }));

		// 明文必须在请求仍在进行中（尚未 resolve）时就已清空。
		expect(input).toHaveValue("");

		resolveFetch(
			new Response(JSON.stringify({ keyVersion: 2, configured: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"已替换（key_version 2）",
			),
		);
	});

	it("请求成功后展示新的 key_version", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ keyVersion: 5, configured: true }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		render(<CredentialReplacePanel agentId="agent-123" />);
		fireEvent.change(screen.getByLabelText("新认证配置"), {
			target: { value: "top-secret" },
		});
		fireEvent.click(screen.getByRole("button", { name: "替换凭证" }));

		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				"已替换（key_version 5）",
			),
		);
		expect(fetch).toHaveBeenCalledWith(
			"https://marketplace-api.test/api/agents/agent-123/credentials",
			expect.objectContaining({
				method: "PUT",
				body: JSON.stringify({ credentialSecret: "top-secret" }),
			}),
		);
	});

	it("网络失败路径下明文已清空且展示错误提示", async () => {
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network error"));

		render(<CredentialReplacePanel agentId="agent-123" />);
		const input = screen.getByLabelText("新认证配置");
		fireEvent.change(input, { target: { value: "top-secret" } });
		fireEvent.click(screen.getByRole("button", { name: "替换凭证" }));

		expect(input).toHaveValue("");
		expect(
			await screen.findByText("凭证替换失败，请稍后重试"),
		).toBeInTheDocument();
	});
});
