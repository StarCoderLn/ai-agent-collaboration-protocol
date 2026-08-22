import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResearchAgentLab from "./research-agent-lab";

describe("ResearchAgentLab", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("renders a completed sandbox report and its verified sources", async () => {
		vi.mocked(fetch).mockResolvedValueOnce(
			Response.json({
				success: true,
				agentId: "evidence-research-agent",
				callType: "sandbox",
				elapsedMs: 92_000,
				result: {
					schemaVersion: "paper.report.v0.1",
					taskId: "lab-task-1",
					title: "可靠 Agent 研究报告",
					executiveSummary: "这是执行摘要。",
					sections: [
						{ heading: "证据", content: "研究发现。", citationIds: ["W1"] },
						{ heading: "结论", content: "研究结论。", citationIds: ["W1"] },
					],
					sources: [
						{
							id: "W1",
							title: "真实论文来源",
							authors: ["研究者"],
							publicationYear: 2025,
							doi: null,
							url: "https://openalex.org/W1",
						},
					],
					limitations: ["只使用了公开元数据"],
					generatedAt: "2026-08-22T00:00:00.000Z",
				},
			}),
		);

		render(<ResearchAgentLab />);
		fireEvent.click(screen.getByRole("button", { name: "开始论文调研" }));

		await waitFor(() =>
			expect(screen.getByText("可靠 Agent 研究报告")).toBeInTheDocument(),
		);
		expect(screen.getByText("沙箱任务完成")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /真实论文来源/ })).toHaveAttribute(
			"href",
			"https://openalex.org/W1",
		);
		expect(fetch).toHaveBeenCalledWith(
			"/api/agent-lab/research",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("validates the year range in the browser before submitting", async () => {
		render(<ResearchAgentLab />);
		fireEvent.change(screen.getByLabelText("起始年份"), {
			target: { value: "2027" },
		});
		fireEvent.change(screen.getByLabelText("结束年份"), {
			target: { value: "2020" },
		});
		fireEvent.click(screen.getByRole("button", { name: "开始论文调研" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"起始年份不能晚于结束年份",
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
