/**
 * 研究汇总测试固定跨节点取证约束：只消费 ResearchArtifact，并在数量上限内公平保留
 * 每个研究节点的事实。这样需求文档不会被误计为研究输入，长报告也不能挤掉后续节点。
 */
import type { QuickRunRequest } from "@aicp/agent-sdk";
import { describe, expect, it } from "vitest";

import { createResearchSynthesisExecutor } from "../src/research-synthesis.js";

describe("research synthesis", () => {
	it("ignores non-research ancestors and preserves evidence from every research node", async () => {
		const execute = createResearchSynthesisExecutor();
		const result = await execute(
			request([
				artifact("requirements", "RequirementsSpec", '{"goals":["不应计入"]}'),
				artifact(
					"market",
					"ResearchArtifact",
					Array.from(
						{ length: 30 },
						(_, index) => `- 市场事实 ${index + 1}：新能源汽车需求持续增长。`,
					).join("\n"),
				),
				artifact(
					"competitor",
					"ResearchArtifact",
					JSON.stringify({
						findings: [
							{
								keyFacts: [
									"特斯拉 Model 3 与小米 SU7 在价格和智能化体验上形成直接竞争。",
									"小米 SU7 通过生态协同形成差异化优势，但仍面临交付能力风险。",
								],
							},
						],
					}),
				),
			]),
			new AbortController().signal,
		);

		const json = result.artifacts.find((item) => item.type === "json")?.content;
		expect(json).toMatchObject({
			schemaVersion: "aicp.research-synthesis.v1",
			executiveSummary: expect.stringContaining("2 个已验收研究阶段"),
		});
		expect(JSON.stringify(json)).toContain('"market"');
		expect(JSON.stringify(json)).toContain('"competitor"');
		expect(JSON.stringify(json)).not.toContain('"requirements"');
	});
});

function artifact(
	workflowNodeId: string,
	outputContract: string,
	bodyOrFileRef: string,
) {
	return { workflowNodeId, outputContract, bodyOrFileRef };
}

function request(
	upstreamArtifacts: QuickRunRequest["upstreamArtifacts"],
): QuickRunRequest {
	return {
		schemaVersion: "dispatch.v1",
		requestId: "request-synthesis",
		assignmentId: "assignment-synthesis",
		task: {
			id: "task-synthesis",
			title: "新能源汽车研究",
			description: "汇总已验收研究",
			pricingType: "fixed",
			budgetMinMinor: "1000000",
			budgetMaxMinor: "1000000",
			currency: "USDC",
			tags: [],
			attachments: [],
		},
		workflow: {
			nodeId: "synthesis",
			nodeKey: "synthesis",
			kind: "research",
			title: "调研汇总与洞察提炼",
			inputContract: "ResearchArtifact",
			outputContract: "ResearchArtifact",
			budgetCapMinor: "1000000",
			agreedAmountMinor: "1000000",
			recoveryMode: false,
		},
		upstreamArtifacts,
		callbacks: {
			ack: "http://127.0.0.1/ack",
			status: "http://127.0.0.1/status",
			results: "http://127.0.0.1/results",
		},
	};
}
