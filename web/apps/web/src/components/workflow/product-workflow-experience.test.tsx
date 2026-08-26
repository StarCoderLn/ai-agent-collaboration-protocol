import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProductWorkflowExperience from "./product-workflow-experience";

const GENERATED_AT = "2026-08-22T00:00:00.000Z";

const requirements = {
	schemaVersion: "requirements.artifact.v0.1",
	taskId: "workflow-experience-v0-1",
	title: "Agent 市场需求",
	problemStatement: "用户需要比较多个 Agent，并把已验收的结果传给下一步。",
	targetUsers: ["产品创建者"],
	goals: ["跑通三步工作流"],
	nonGoals: ["本阶段不结算"],
	userStories: [
		{
			id: "US-1",
			statement: "选择 Agent",
			acceptanceCriteria: ["展示三个候选"],
		},
	],
	functionalRequirements: ["逐步解锁"],
	constraints: ["不泄露密钥"],
	assumptions: [],
	openQuestions: [],
	executableTasks: [
		{
			id: "T-1",
			title: "实现需求步骤",
			description: "生成需求制品",
			dependsOn: [],
			acceptanceCriteria: ["schema 合法"],
		},
	],
	generatedBy: { agentId: "prd-direct", strategy: "direct" },
	generatedAt: GENERATED_AT,
};

const design = {
	schemaVersion: "design.artifact.v0.1",
	taskId: "workflow-experience-v0-1",
	title: "工作流设计稿",
	direction: "清晰展示三个串联步骤和每一步的候选 Agent。",
	tokens: {
		primaryColor: "#123456",
		secondaryColor: "#abcdef",
		backgroundColor: "#f5f5f5",
		textColor: "#111111",
		borderRadius: "8px",
		spacingBase: "8px",
		fontFamily: "sans-serif",
	},
	pages: [
		{
			id: "main",
			name: "主流程",
			purpose: "执行工作流",
			sections: ["需求", "设计", "代码"],
		},
	],
	components: [
		{
			id: "root",
			name: "流程",
			parentId: null,
			responsibility: "展示步骤",
			states: ["默认"],
		},
	],
	interactionRules: ["验收后解锁"],
	responsiveRules: ["手机纵向排列"],
	accessibilityRules: ["使用语义标签"],
	assetPlan: [],
	svgPreview: '<svg xmlns="http://www.w3.org/2000/svg"><text>预览</text></svg>',
	generatedBy: { agentId: "design-direct", strategy: "direct" },
	generatedAt: GENERATED_AT,
};

const code = {
	schemaVersion: "code.artifact.v0.1",
	taskId: "workflow-experience-v0-1",
	title: "工作流前端",
	implementationSummary: "实现可选择、执行和验收的三步工作流页面。",
	fileTree: ["src/app.tsx"],
	files: [
		{
			path: "src/app.tsx",
			language: "tsx",
			content: "export function App() { return <main />; }",
		},
	],
	runInstructions: ["pnpm dev"],
	testPlan: ["运行组件测试"],
	limitations: [],
	generatedBy: { agentId: "code-direct", strategy: "direct" },
	generatedAt: GENERATED_AT,
};

describe("ProductWorkflowExperience", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		window.sessionStorage.clear();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
	});

	it("runs the three configured canvas nodes with accepted upstream artifacts", async () => {
		vi.mocked(fetch)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					agentId: "prd-direct",
					callType: "sandbox",
					elapsedMs: 10,
					result: requirements,
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					agentId: "design-direct",
					callType: "sandbox",
					elapsedMs: 10,
					result: design,
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					success: true,
					agentId: "code-direct",
					callType: "sandbox",
					elapsedMs: 10,
					result: code,
				}),
			);

		render(<ProductWorkflowExperience />);

		// 每个阶段的候选只在当前步骤右侧显示；先为三个画布节点各配置一个 Agent。
		fireEvent.click(
			screen.getByRole("button", {
				name: "将 快速需求整理 Agent 放入 PRD 节点",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "查看UI 设计系统步骤" }));
		fireEvent.click(
			screen.getByRole("button", {
				name: "将 快速界面设计 Agent 放入 设计 节点",
			}),
		);
		fireEvent.click(screen.getByRole("button", { name: "查看Coding 实现步骤" }));
		fireEvent.click(
			screen.getByRole("button", {
				name: "将 快速代码生成 Agent 放入 Coding 节点",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", { name: "查看需求与 PRD步骤" }),
		);

		fireEvent.click(screen.getByRole("button", { name: "运行 PRD Agent" }));
		expect(await screen.findByText("Agent 市场需求")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "验收并解锁下一步" }));

		fireEvent.click(screen.getByRole("button", { name: "运行 设计 Agent" }));
		expect(await screen.findByText("工作流设计稿")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "验收并解锁下一步" }));

		fireEvent.click(screen.getByRole("button", { name: "运行 Coding Agent" }));
		expect(await screen.findByText("工作流前端")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "验收并解锁下一步" }));

		expect(screen.getByText("三步 Agent 流程已完成")).toBeInTheDocument();
		expect(fetch).toHaveBeenCalledTimes(3);
		const designRequest = JSON.parse(
			String(vi.mocked(fetch).mock.calls[1]?.[1]?.body),
		);
		const codeRequest = JSON.parse(
			String(vi.mocked(fetch).mock.calls[2]?.[1]?.body),
		);
		expect(designRequest.requirements.title).toBe("Agent 市场需求");
		expect(codeRequest.requirements.title).toBe("Agent 市场需求");
		expect(codeRequest.design.title).toBe("工作流设计稿");

		// 同一标签页刷新/重挂载必须恢复已验收制品，不能让用户重复支付三次模型调用。
		cleanup();
		render(<ProductWorkflowExperience />);
		expect(await screen.findByText("三步 Agent 流程已完成")).toBeInTheDocument();
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it("supports dragging a candidate Agent into its canvas node", () => {
		render(<ProductWorkflowExperience />);
		const transfer = createDataTransfer();
		const candidate = screen.getByText("快速需求整理 Agent").closest("article");
		expect(candidate).not.toBeNull();

		fireEvent.dragStart(candidate as HTMLElement, { dataTransfer: transfer });
		fireEvent.dragOver(screen.getByTestId("workflow-node-requirements"), {
			dataTransfer: transfer,
		});
		fireEvent.drop(screen.getByTestId("workflow-node-requirements"), {
			dataTransfer: transfer,
		});

		expect(screen.getByTestId("workflow-node-requirements")).toHaveTextContent(
			"快速需求整理 Agent",
		);
		expect(
			screen.getByRole("button", {
				name: "将 快速需求整理 Agent 放入 PRD 节点",
			}),
		).toHaveTextContent("已在画布中");
	});

	it("restores validated canvas configuration after a page remount", async () => {
		render(<ProductWorkflowExperience />);
		fireEvent.click(
			screen.getByRole("button", {
				name: "将 快速需求整理 Agent 放入 PRD 节点",
			}),
		);
		await waitFor(() =>
			expect(window.sessionStorage.getItem("aicp.product-workflow.session.v1")).toContain("prd-direct"),
		);

		cleanup();
		render(<ProductWorkflowExperience />);
		expect(await screen.findByTestId("workflow-node-requirements")).toHaveTextContent(
			"快速需求整理 Agent",
		);
	});
});

function createDataTransfer() {
	const values = new Map<string, string>();
	return {
		effectAllowed: "none",
		dropEffect: "none",
		setData: (type: string, value: string) => values.set(type, value),
		getData: (type: string) => values.get(type) ?? "",
	};
}
