import {
	createQuickAgentServer,
	FileArtifactStore,
	loadQuickAgentConfig,
} from "@aicp/agent-sdk";
import { BROWSER_RESEARCH_AGENT } from "./catalog.js";
import { loadBrowserRuntimeConfig } from "./config.js";
import { createBrowserResearchExecutor } from "./research-agent.js";
import { createResearchSynthesisExecutor } from "./research-synthesis.js";
import {
	BraveResearchSourceDiscovery,
	FallbackResearchSourceDiscovery,
	SogouResearchSourceDiscovery,
} from "./source-discovery.js";
import { StagehandResearchSessionFactory } from "./stagehand-browser.js";

/**
 * Browser Agent 的进程装配入口。这里只连接配置、制品存储、浏览器工厂和通用 Quick Agent
 * HTTP 运行时，不放业务规则；这样测试可以直接注入会话替身，而无需监听端口或启动 Chromium。
 * 20 分钟是整个多页面任务的上限，单次页面导航和模型请求仍由各自更短的超时保护。
 */
const config = loadQuickAgentConfig(process.env, 9_304);
const artifactStore = new FileArtifactStore(
	config.artifactDirectory,
	config.publicBaseUrl,
);
const runtimeConfig = loadBrowserRuntimeConfig(process.env);
const browserFactory = new StagehandResearchSessionFactory(runtimeConfig);
const server = createQuickAgentServer({
	name: BROWSER_RESEARCH_AGENT.name,
	...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
	artifactStore,
	responseCacheDirectory: config.responseCacheDirectory,
	executionTimeoutMs: 20 * 60_000,
	execute: createBrowserResearchExecutor(
		browserFactory,
		undefined,
		new FallbackResearchSourceDiscovery([
			new BraveResearchSourceDiscovery(),
			new SogouResearchSourceDiscovery(),
		]),
		createResearchSynthesisExecutor(),
	),
});

server.listen(config.port, config.host, () => {
	console.log(`${BROWSER_RESEARCH_AGENT.name}已监听 ${config.publicBaseUrl}`);
});
