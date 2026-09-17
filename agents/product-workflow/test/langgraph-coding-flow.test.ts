import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { LangGraphCodingFlow } from "../src/agents/coding/langgraph-coding-flow.js";
import { CodingLangGraphAgent } from "../src/agents/coding/langgraph-agent.js";
import { renderDesignScreens } from "../src/design-renderer.js";
import { DesignArtifactSchema } from "../src/domain.js";
import { ModelOutputError, type WorkflowModelClient } from "../src/model-client.js";

const PAGE = `export default function Page() {
	return <main data-design-id="hero"><h1>LangGraph 页面</h1><p>从已验收的页面结构继续生成样式。</p></main>;
}`;
const CSS = `
:root { color: #172033; background: #f8fafc; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: linear-gradient(135deg, #f8fafc, #f3e8ff); }
main { width: min(72rem, calc(100% - 2rem)); margin: 4rem auto; padding: 2rem; color: #7c3aed; border: 1px solid #ddd6fe; border-radius: 12px; }
h1 { margin: 0 0 1rem; font-size: clamp(2rem, 5vw, 4rem); }
p { margin: 0; line-height: 1.7; color: #64748b; }
@media (max-width: 768px) { main { margin: 1rem auto; padding: 1rem; } }
`;

class CodingClient implements WorkflowModelClient {
	pageCalls = 0;
	styleCalls = 0;
	readonly styleResults: Array<string | Error> = [];

	async generateJson<T>(options: { schema: z.ZodType<T> }): Promise<T> {
		return options.schema.parse({});
	}
	async generateCodeFiles() {
		return { pageTsx: PAGE, globalsCss: CSS };
	}
	async generateCodePage() {
		this.pageCalls += 1;
		return PAGE;
	}
	async generateCodeStyles() {
		this.styleCalls += 1;
		const result = this.styleResults.shift() ?? CSS;
		if (result instanceof Error) throw result;
		return result;
	}
}

describe("LangGraph Coding 编排", () => {
	it("按显式图完成页面和样式生成", async () => {
		const client = new CodingClient();
		const flow = new LangGraphCodingFlow(client, new MemorySaver());

		await expect(flow.run("coding:normal", codingInput())).resolves.toEqual({
			pageTsx: PAGE,
			globalsCss: CSS,
		});
		expect(client.pageCalls).toBe(1);
		expect(client.styleCalls).toBe(1);
	});

	it("输出校验失败时沿条件边只重做失败片段", async () => {
		const client = new CodingClient();
		client.styleResults.push(
			new ModelOutputError("MODEL_OUTPUT_INVALID", [{ path: "globalsCss", code: "CSS_SYNTAX_INVALID" }], "code_styles"),
			CSS,
		);
		const flow = new LangGraphCodingFlow(client, new MemorySaver());

		await expect(flow.run("coding:repair", codingInput())).resolves.toMatchObject({ globalsCss: CSS });
		expect(client.pageCalls).toBe(1);
		expect(client.styleCalls).toBe(2);
	});

	it("基础设施失败后从检查点恢复且不重新生成已验收页面", async () => {
		const client = new CodingClient();
		client.styleResults.push(new Error("provider unavailable"), CSS);
		const flow = new LangGraphCodingFlow(client, new MemorySaver());

		await expect(flow.run("coding:resume", codingInput())).rejects.toThrow("provider unavailable");
		await expect(flow.resume("coding:resume")).resolves.toEqual({ pageTsx: PAGE, globalsCss: CSS });
		expect(client.pageCalls).toBe(1);
		expect(client.styleCalls).toBe(2);
	});

	it("正式执行器使用稳定 executionId 恢复并装配现有代码制品契约", async () => {
		const client = new CodingClient();
		client.styleResults.push(new Error("provider unavailable"), CSS);
		const agent = new CodingLangGraphAgent({
			jsonClient: client,
			mastraModel: "deepseek/test",
			modelStepTimeoutMs: 1_000,
			now: () => new Date("2026-09-12T00:00:00.000Z"),
		}, new MemorySaver());
		await expect(agent.run(codingInput(), { executionId: "assignment-1:initial" }))
			.rejects.toThrow("provider unavailable");
		const artifact = await agent.run(codingInput(), {
			executionId: "assignment-1:initial",
			recoveryMode: true,
		});
		expect(artifact.generatedBy).toEqual({ agentId: "code-langgraph", strategy: "langgraph" });
		expect(client.pageCalls).toBe(1);
		expect(client.styleCalls).toBe(2);
	});

	it.runIf(process.env.LANGGRAPH_POSTGRES_TEST_DATABASE_URL !== undefined)(
		"关闭数据库连接后仍能从 PostgreSQL 检查点恢复",
		async () => {
			const databaseUrl = process.env.LANGGRAPH_POSTGRES_TEST_DATABASE_URL;
			if (databaseUrl === undefined) throw new Error("integration database URL is required");
			const threadId = `coding:postgres:${randomUUID()}`;
			const firstSaver = PostgresSaver.fromConnString(databaseUrl, { schema: "langgraph_test" });
			await firstSaver.setup();
			const firstClient = new CodingClient();
			firstClient.styleResults.push(new Error("provider unavailable"));
			await expect(new LangGraphCodingFlow(firstClient, firstSaver).run(threadId, codingInput()))
				.rejects.toThrow("provider unavailable");
			await firstSaver.end();

			const restartedSaver = PostgresSaver.fromConnString(databaseUrl, { schema: "langgraph_test" });
			const restartedClient = new CodingClient();
			await expect(new LangGraphCodingFlow(restartedClient, restartedSaver).resume(threadId))
				.resolves.toEqual({ pageTsx: PAGE, globalsCss: CSS });
			expect(restartedClient.pageCalls).toBe(0);
			expect(restartedClient.styleCalls).toBe(1);
			await restartedSaver.deleteThread(threadId);
			await restartedSaver.end();
		},
	);
});

function codingInput() {
	const designDraft = {
		title: "LangGraph 页面",
		direction: "使用柔和紫色表现可靠的 Agent 编排过程，并清晰展示可恢复执行状态。",
		tokens: {
			primaryColor: "#7C3AED",
			secondaryColor: "#64748B",
			backgroundColor: "#F8FAFC",
			textColor: "#172033",
			borderRadius: "12px" as const,
			spacingBase: "8px" as const,
			fontFamily: "system-ui",
		},
		pages: [{ id: "home", name: "编排首页", purpose: "展示 LangGraph 节点执行与恢复结果。", sections: ["执行状态", "产物", "恢复记录"] }],
		components: [{ id: "hero", name: "编排概览", parentId: null, responsibility: "说明当前执行状态和下一步操作。", states: ["运行中", "已恢复"] }],
		interactionRules: ["点击查看工作流详情"],
		responsiveRules: ["移动端使用单列布局"],
		accessibilityRules: ["按钮具有可访问名称"],
		assetPlan: [],
		preview: {
			navigation: { brand: "AICP", items: [{ label: "任务", active: true }, { label: "Agent", active: false }], action: "发布需求" },
			hero: { eyebrow: "可靠编排", title: "LangGraph Coding", description: "从最近检查点继续生成已验证的前端制品。", primaryAction: "查看执行图", secondaryAction: null },
			metrics: [{ label: "恢复状态", value: "可恢复", detail: "保留已验收 TSX", tone: "success" as const }],
			sections: [
				previewSection("execution", "执行状态", "页面生成已经通过可信校验。"),
				previewSection("artifacts", "代码产物", "分别保存页面结构和样式文件。"),
				previewSection("recovery", "恢复记录", "失败后从最近成功节点继续执行。"),
			],
		},
	};
	const design = DesignArtifactSchema.parse({
		...designDraft,
		schemaVersion: "design.artifact.v0.4",
		taskId: "task-langgraph-poc",
		rendererVersion: "aicp-design-renderer.v1",
		renderedScreens: renderDesignScreens(designDraft),
		generatedBy: { agentId: "design-direct", strategy: "direct" },
		generatedAt: "2026-09-12T00:00:00.000Z",
	});
	return {
		schemaVersion: "workflow.execute.v0.1" as const,
		taskId: "task-langgraph-poc",
		step: "code" as const,
		agentId: "code-langgraph" as const,
		userRequest: "根据已验收设计稿实现响应式页面。",
		requirements: {
			schemaVersion: "task.requirements.v1" as const,
			taskId: "task-langgraph-poc",
			title: "LangGraph Coding PoC",
			description: "根据已验收设计制品生成完整页面，并在局部失败后恢复执行。",
			acceptanceCriteria: "TSX 和 CSS 均通过可信校验，恢复时不重复生成已验收文件。",
			deliverableFormat: "Next.js TSX 与 CSS 源码",
		},
		design,
	};
}

function previewSection(id: string, title: string, description: string) {
	return {
		id,
		kind: "cards" as const,
		layout: "split" as const,
		title,
		description,
		items: [1, 2].map((index) => ({
			title: `${title}${index}`,
			description: `${description}步骤 ${index}`,
			value: index === 1 ? "已完成" : "待执行",
			status: index === 1 ? "成功" : "等待",
			progress: index === 1 ? 100 : 0,
			action: "查看详情",
			tone: index === 1 ? "success" as const : "neutral" as const,
		})),
	};
}
