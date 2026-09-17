import type { QuickAgentExecutor, QuickRunRequest } from "@aicp/agent-sdk";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import {
	type BrowserResearchInput,
	BrowserResearchInputSchema,
	BrowserResearchIntentSchema,
	type BrowserResearchReport,
	BrowserResearchReportSchema,
	type PageFailure,
	type PageFinding,
} from "./domain.js";
import {
	approveResearchTargets,
	type DnsLookup,
	UrlPolicyError,
} from "./public-url-policy.js";
import type { ResearchSourceDiscovery } from "./source-discovery.js";
import { workflowOutputContract } from "./research-synthesis.js";
import {
	type BrowserResearchSession,
	type BrowserResearchSessionFactory,
	PageNavigationError,
} from "./stagehand-browser.js";

/**
 * LangGraph 状态只保存可序列化的研究进度，不保存浏览器或 Stagehand 实例。数组 reducer 采用
 * 追加语义，使一个页面失败后已经完成的证据不会被下一节点覆盖；`index` 则始终以后一次
 * 节点返回值为准，保证每个 URL 最多处理一次。
 */
const ResearchState = Annotation.Root({
	input: Annotation<BrowserResearchInput>,
	index: Annotation<number>({
		default: () => 0,
		reducer: (_left, right) => right,
	}),
	findings: Annotation<readonly PageFinding[]>({
		default: () => [],
		reducer: (left, right) => [...left, ...right],
	}),
	failures: Annotation<readonly PageFailure[]>({
		default: () => [],
		reducer: (left, right) => [...left, ...right],
	}),
});

/**
 * LangGraph 只负责逐页推进和单页失败隔离。浏览器权限、导航和自然语言提取由
 * BrowserResearchSession 隐藏；一个页面失败不会丢失已经完成的来源，也不会阻止剩余页面。
 */
export class BrowserResearchFlow {
	readonly #graph;

	constructor(private readonly session: BrowserResearchSession) {
		this.#graph = new StateGraph(ResearchState)
			.addNode("research_page", (state, config) =>
				this.#researchPage(state, config.signal),
			)
			.addEdge(START, "research_page")
			.addConditionalEdges("research_page", routeNext, {
				research_page: "research_page",
				complete: END,
			})
			.compile();
	}

	async run(
		input: BrowserResearchInput,
		signal: AbortSignal,
	): Promise<BrowserResearchReport> {
		const state = await this.#graph.invoke(
			{ input, index: 0, findings: [], failures: [] },
			{ signal },
		);
		return BrowserResearchReportSchema.parse({
			schemaVersion: "aicp.browser-research.v1",
			goal: input.goal,
			findings: state.findings,
			failures: state.failures,
			sourceCount: state.findings.length,
			generatedAt: new Date().toISOString(),
		});
	}

	async #researchPage(
		state: typeof ResearchState.State,
		signal: AbortSignal | undefined,
	) {
		const url = new URL(state.input.urls[state.index] ?? "");
		try {
			const finding = await this.session.research(
				url,
				state.input.goal,
				signal ?? new AbortController().signal,
			);
			return { index: state.index + 1, findings: [finding] };
		} catch (error) {
			if (signal?.aborted === true)
				throw signal.reason instanceof Error ? signal.reason : error;
			return {
				index: state.index + 1,
				failures: [{ sourceUrl: url.href, ...publicFailure(error) }],
			};
		}
	}
}

export function createBrowserResearchExecutor(
	factory: BrowserResearchSessionFactory,
	resolve?: DnsLookup,
	discovery?: ResearchSourceDiscovery,
	synthesis?: QuickAgentExecutor,
): QuickAgentExecutor {
	/**
	 * 同一进程共用一个槽位，把 Chromium 峰值限制为一个会话。URL 审批在拿到槽位后执行，
	 * 可以避免排队任务提前做外部 DNS 查询；无论图执行成功还是失败，finally 都关闭会话。
	 */
	const slot = new SingleBrowserSlot();
	return async (request, signal) => {
		if (workflowInputContract(request.workflow) === "ResearchArtifact") {
			if (workflowOutputContract(request.workflow) !== "ResearchArtifact") {
				throw new Error(
					`网页调研助手不能处理包含上游制品的输出契约：${workflowOutputContract(request.workflow) ?? "未提供"}`,
				);
			}
			if (synthesis === undefined)
				throw new Error("研究综合执行器尚未配置");
			return synthesis(request, signal);
		}
		if (
			request.upstreamArtifacts.length > 0 &&
			workflowOutputContract(request.workflow) !== "ResearchArtifact"
		) {
			throw new Error(
				`网页调研助手不能处理包含上游制品的输出契约：${workflowOutputContract(request.workflow) ?? "未提供"}`,
			);
		}
		return slot.run(async () => {
			const intent = browserResearchInput(request);
			// 显式 URL 始终优先；只有任务完全没有给出来源时才启动搜索，避免改变已有任务的
			// 访问范围。来源发现只负责给出候选地址，所有候选仍统一经过 SSRF 审批边界。
			const urls =
				intent.urls.length > 0
					? intent.urls
					: await discoverRequiredSources(discovery, intent.goal, signal);
			const input = BrowserResearchInputSchema.parse({
				goal: intent.goal,
				urls,
			});
			const targets = await approveResearchTargets(input.urls, resolve);
			const session = await factory.open(targets.domains);
			try {
				const report = await new BrowserResearchFlow(session).run(
					{ ...input, urls: targets.urls.map((url) => url.href) },
					signal,
				);
				return {
					status: "completed",
					artifacts: [
						{
							type: "document",
							summary: `公开网页研究报告：${report.sourceCount} 个来源提取成功`,
							content: renderMarkdown(report),
							mimeType: "text/markdown; charset=utf-8",
						},
						{
							type: "json",
							summary:
								"包含来源 URL、访问时间、结构化事实与失败列表的机器可读报告",
							content: report,
							mimeType: "application/json",
						},
					],
				};
			} finally {
				await session.close();
			}
		}, signal);
	};
}

export function browserResearchInput(
	request: QuickRunRequest,
): Readonly<{ goal: string; urls: readonly string[] }> {
	// URL 只从用户明确填写的任务字段提取，不读取上游 Agent 产物，防止不可信产物扩大访问范围。
	const text = [
		request.task.description,
		request.task.acceptanceCriteria,
		request.task.deliverableFormat,
	]
		.filter((value): value is string => typeof value === "string")
		.join("\n");
	const urls = [
		...new Set(
			text
				.match(/https?:\/\/[^\s<>{}[\]"'`，。；！？、]+/g)
				?.map(trimTrailingPunctuation) ?? [],
		),
	];
	// 此处只解析研究意图，允许暂时没有 URL；BrowserResearchFlow 的正式输入仍要求至少一个
	// 已批准来源，防止来源发现失败后生成看似成功、实则没有证据的空报告。
	return BrowserResearchIntentSchema.parse({
		// 正式 DAG 派发会携带当前节点标题。它比整单标题更具体，必须作为搜索目标，
		// 否则两个并行研究节点会用同一宽泛关键词发现近似来源。Quick Agent 契约允许
		// 扩展字段，因此这里在消费前单独验证，旧的非工作流请求仍保持原有回退顺序。
		goal:
			workflowNodeTitle(request.workflow) ??
			request.task.title ??
			request.task.description ??
			"研究给定网页",
		urls,
	});
}

function workflowNodeTitle(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const title = Reflect.get(value, "title");
	return typeof title === "string" && title.trim() !== ""
		? title.trim()
		: undefined;
}

function workflowInputContract(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const contract = Reflect.get(value, "inputContract");
	return typeof contract === "string" && contract.trim() !== ""
		? contract.trim()
		: undefined;
}

async function discoverRequiredSources(
	discovery: ResearchSourceDiscovery | undefined,
	goal: string,
	signal: AbortSignal,
): Promise<readonly string[]> {
	if (discovery === undefined) {
		throw new Error("任务未提供网页来源，且来源发现服务尚未配置");
	}
	const urls = await discovery.discover(goal, signal);
	if (urls.length === 0) {
		throw new Error("没有发现可用于本次研究的公开网页来源");
	}
	return urls;
}

function routeNext(
	state: typeof ResearchState.State,
): "research_page" | "complete" {
	return state.index < state.input.urls.length ? "research_page" : "complete";
}

function publicFailure(error: unknown): Omit<PageFailure, "sourceUrl"> {
	// 只公开平台定义的稳定错误；模型、SDK 和网页正文异常统一收敛，避免远端内容进入制品。
	if (error instanceof UrlPolicyError)
		return { code: "POLICY_BLOCKED", message: error.message };
	if (error instanceof PageNavigationError)
		return { code: "NAVIGATION_FAILED", message: error.message };
	return { code: "EXTRACTION_FAILED", message: "页面内容提取失败" };
}

function trimTrailingPunctuation(url: string): string {
	return url.replace(/[),.;!?，。；！？]+$/u, "");
}

function renderMarkdown(report: BrowserResearchReport): string {
	// Markdown 是给用户阅读的视图，JSON 报告仍是下游自动化的唯一结构化事实源。
	const findings = report.findings.map((finding, index) =>
		[
			`## ${index + 1}. ${finding.pageTitle || finding.sourceUrl}`,
			`- 来源：${finding.sourceUrl}`,
			`- 访问时间：${finding.accessedAt}`,
			"",
			finding.summary,
			"",
			"### 关键事实",
			...(finding.keyFacts.length === 0
				? ["- 页面未提供可确认的关键事实"]
				: finding.keyFacts.map((fact) => `- ${fact}`)),
			...(finding.relevantQuotes.length === 0
				? []
				: [
						"",
						"### 原文摘录",
						...finding.relevantQuotes.map((quote) => `> ${quote}`),
					]),
		].join("\n"),
	);
	const failures =
		report.failures.length === 0
			? []
			: [
					"## 未完成页面",
					...report.failures.map(
						(failure) =>
							`- ${failure.sourceUrl}：${failure.message}（${failure.code}）`,
					),
				];
	return [
		`# ${report.goal}`,
		"",
		...findings,
		"",
		...failures,
		"",
		`生成时间：${report.generatedAt}`,
	].join("\n");
}

class SingleBrowserSlot {
	#tail: Promise<void> = Promise.resolve();

	/**
	 * Promise 尾链实现进程内 FIFO 互斥，不需要额外队列依赖。等待结束后必须再次检查取消
	 * 信号，否则已取消请求仍会启动昂贵的 Chromium；finally 释放槽位以防后续任务永久阻塞。
	 */
	async run<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
		const previous = this.#tail;
		let release = () => {};
		this.#tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			if (signal.aborted)
				throw signal.reason instanceof Error
					? signal.reason
					: new Error("任务已取消");
			return await operation();
		} finally {
			release();
		}
	}
}
