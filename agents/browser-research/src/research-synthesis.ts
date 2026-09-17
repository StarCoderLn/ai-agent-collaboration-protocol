import type { QuickAgentExecutor, QuickRunRequest } from "@aicp/agent-sdk";

type Evidence = Readonly<{
	claim: string;
	sourceNodeIds: readonly string[];
}>;

type ResearchSynthesis = Readonly<{
	executiveSummary: string;
	conclusions: readonly string[];
	opportunities: readonly string[];
	risks: readonly string[];
	evidence: readonly Evidence[];
	limitations: readonly string[];
}>;

const OPPORTUNITY_TERMS = [
	"增长",
	"提升",
	"提高",
	"突破",
	"政策",
	"需求",
	"意向",
	"优势",
	"领先",
	"渗透率",
] as const;
const RISK_TERMS = [
	"下滑",
	"不足",
	"缺口",
	"风险",
	"挑战",
	"竞争",
	"负面",
	"不成熟",
	"失败",
	"限制",
] as const;

/**
 * 已验收上游研究制品在本机完成确定性汇总，绝不再次发送给搜索引擎或模型供应商。
 * 汇总只选取上游原文中的事实句，并为每条结论保留 workflowNodeId；这样即使外部模型
 * 不可用，DAG 仍能恢复执行，而且不会把新推断伪装成网页证据。
 */
export function createResearchSynthesisExecutor(): QuickAgentExecutor {
	return async (request, signal) => {
		assertResearchSynthesisRequest(request);
		if (signal.aborted) throw abortReason(signal);
		const researchArtifacts = request.upstreamArtifacts.filter(
			(artifact) => artifact.outputContract === "ResearchArtifact",
		);
		const evidence = collectEvidence(researchArtifacts);
		if (evidence.length < 2) {
			throw new Error("已验收上游制品缺少可汇总的事实内容");
		}
		const researchNodeCount = new Set(
			researchArtifacts.map((artifact, index) =>
				artifact.workflowNodeId === undefined
					? `upstream-${index + 1}`
					: artifact.workflowNodeId,
			),
		).size;
		const synthesis = synthesize(evidence, researchNodeCount);
		return {
			status: "completed",
			artifacts: [
				{
					type: "document",
					summary: "已验收市场与竞品研究的综合洞察报告",
					content: renderSynthesisMarkdown(synthesis),
					mimeType: "text/markdown; charset=utf-8",
				},
				{
					type: "json",
					summary: "包含结论、机会、风险与上游节点证据映射的机器可读报告",
					content: {
						schemaVersion: "aicp.research-synthesis.v1",
						...synthesis,
					},
					mimeType: "application/json",
				},
			],
		};
	};
}

function assertResearchSynthesisRequest(request: QuickRunRequest): void {
	const outputContract = workflowOutputContract(request.workflow);
	if (outputContract !== "ResearchArtifact") {
		throw new Error(`网页调研助手不支持输出契约：${outputContract ?? "未提供"}`);
	}
	if (request.upstreamArtifacts.length === 0) {
		throw new Error("研究综合节点缺少已验收上游制品");
	}
}

export function workflowOutputContract(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const contract = Reflect.get(value, "outputContract");
	return typeof contract === "string" && contract.trim() !== ""
		? contract.trim()
		: undefined;
}

function collectEvidence(
	artifacts: QuickRunRequest["upstreamArtifacts"],
): readonly Evidence[] {
	const evidence: Evidence[] = [];
	const sources = artifacts.map((artifact, index) => ({
		nodeId: artifact.workflowNodeId ?? `upstream-${index + 1}`,
		claims: extractClaims(artifact.bodyOrFileRef ?? ""),
	}));
	// 每轮只从每个研究节点取一条事实，防止排在前面的长报告先占满 24 条上限，
	// 导致后续竞品或区域研究完全没有进入结论和证据映射。
	const maximumClaims = Math.max(0, ...sources.map((source) => source.claims.length));
	for (let claimIndex = 0; claimIndex < maximumClaims; claimIndex += 1) {
		for (const source of sources) {
			const claim = source.claims[claimIndex];
			if (claim === undefined) continue;
			const duplicateIndex = evidence.findIndex((item) => item.claim === claim);
			if (duplicateIndex >= 0) {
				const duplicate = evidence[duplicateIndex];
				if (duplicate !== undefined && !duplicate.sourceNodeIds.includes(source.nodeId)) {
					evidence[duplicateIndex] = {
						...duplicate,
						sourceNodeIds: [...duplicate.sourceNodeIds, source.nodeId],
					};
				}
				continue;
			}
			evidence.push({ claim, sourceNodeIds: [source.nodeId] });
			if (evidence.length >= 24) return evidence;
		}
	}
	return evidence;
}

function extractClaims(content: string): readonly string[] {
	const structured = parseResearchJson(content);
	if (structured.length > 0) return structured;
	return content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2).trim())
		.filter(isMeaningfulClaim)
		.map((line) => line.slice(0, 500));
}

function parseResearchJson(content: string): readonly string[] {
	try {
		const parsed: unknown = JSON.parse(content);
		if (typeof parsed !== "object" || parsed === null) return [];
		const findings = Reflect.get(parsed, "findings");
		if (!Array.isArray(findings)) return [];
		return findings.flatMap((finding) => {
			if (typeof finding !== "object" || finding === null) return [];
			const facts = Reflect.get(finding, "keyFacts");
			return Array.isArray(facts)
				? facts
						.filter((fact): fact is string => typeof fact === "string")
						.map((fact) => fact.trim().slice(0, 500))
						.filter(isMeaningfulClaim)
				: [];
		});
	} catch {
		return [];
	}
}

function isMeaningfulClaim(value: string): boolean {
	return (
		value.length >= 12 &&
		!value.startsWith("来源：") &&
		!value.startsWith("访问时间：") &&
		!value.includes("页面未提供")
	);
}

function synthesize(
	evidence: readonly Evidence[],
	upstreamCount: number,
): ResearchSynthesis {
	const select = (terms: readonly string[], limit: number) =>
		evidence
			.filter((item) => terms.some((term) => item.claim.includes(term)))
			.slice(0, limit);
	const opportunities = select(OPPORTUNITY_TERMS, 5);
	const risks = select(RISK_TERMS, 5);
	const conclusions = evidence.slice(0, 8);
	return {
		executiveSummary: `本报告合并 ${upstreamCount} 个已验收研究阶段，共提取 ${evidence.length} 条可追溯事实。结论仅来自上游制品，重点覆盖市场变化、用户需求、代表车型竞争与已披露风险。`,
		conclusions: conclusions.map((item) => item.claim),
		opportunities: (opportunities.length > 0
			? opportunities
			: conclusions.slice(0, 3)
		).map((item) => item.claim),
		risks: (risks.length > 0 ? risks : conclusions.slice(-2)).map(
			(item) => item.claim,
		),
		evidence,
		limitations: [
			"汇总未新增外部检索，仅反映已验收上游制品中的事实。",
			"不同来源的统计时间和口径可能不同，精确比较前需回看对应来源。",
		],
	};
}

function renderSynthesisMarkdown(synthesis: ResearchSynthesis): string {
	const section = (title: string, items: readonly string[]) => [
		`## ${title}`,
		...items.map((item) => `- ${item}`),
	];
	return [
		"# 调研汇总与洞察提炼",
		"",
		"## 执行摘要",
		synthesis.executiveSummary,
		"",
		...section("核心结论", synthesis.conclusions),
		"",
		...section("机会点", synthesis.opportunities),
		"",
		...section("风险点", synthesis.risks),
		"",
		"## 证据映射",
		...synthesis.evidence.map(
			(item) => `- ${item.claim}（上游节点：${item.sourceNodeIds.join("、")}）`,
		),
		"",
		...section("研究局限", synthesis.limitations),
	].join("\n");
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("任务已取消");
}
