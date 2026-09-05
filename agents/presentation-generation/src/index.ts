import {
	createQuickAgentServer,
	FileArtifactStore,
	loadQuickAgentConfig,
} from "@aicp/agent-sdk";
import {
	createPresentationAgentExecutor,
	MastraPresentationPlanner,
} from "./presentation-agent.js";
import { loadPresentationModel } from "./config.js";

const config = loadQuickAgentConfig(process.env, 9_302);
const artifactStore = new FileArtifactStore(config.artifactDirectory, config.publicBaseUrl);
const planner = new MastraPresentationPlanner(loadPresentationModel(process.env));
const server = createQuickAgentServer({
	name: "商业演示文稿 Agent",
	...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
	artifactStore,
	responseCacheDirectory: config.responseCacheDirectory,
	execute: createPresentationAgentExecutor(planner, artifactStore),
});

server.listen(config.port, config.host, () => {
	console.log(`商业演示文稿 Agent 已监听 ${config.publicBaseUrl}`);
});
