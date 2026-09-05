import {
	createQuickAgentServer,
	FileArtifactStore,
	loadQuickAgentConfig,
} from "@aicp/agent-sdk";
import { createImageAgentExecutor, MastraImageDesigner } from "./image-agent.js";
import { loadImageModel } from "./config.js";

// 组合根只负责创建具体依赖；生成逻辑不读取全局环境，便于测试时替换模型与存储。
const config = loadQuickAgentConfig(process.env, 9_301);
const artifactStore = new FileArtifactStore(config.artifactDirectory, config.publicBaseUrl);
const designer = new MastraImageDesigner(loadImageModel(process.env));
const server = createQuickAgentServer({
	name: "品牌营销图片 Agent",
	...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
	artifactStore,
	responseCacheDirectory: config.responseCacheDirectory,
	execute: createImageAgentExecutor(designer, artifactStore),
});

server.listen(config.port, config.host, () => {
	console.log(`品牌营销图片 Agent 已监听 ${config.publicBaseUrl}`);
});
