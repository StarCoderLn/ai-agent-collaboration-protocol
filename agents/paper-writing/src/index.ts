import {
  createQuickAgentServer,
  FileArtifactStore,
  loadQuickAgentConfig,
} from "@aicp/agent-sdk";
import { loadConfig } from "./config.js";
import { MastraResearchExecutor } from "./mastra-executor.js";
import { createQuickPaperExecutor } from "./quick-paper.js";

// 组合根只连接模型配置、Mastra 执行器和 SDK 快速服务外壳。论文业务代码无需理解
// HTTP、Bearer、幂等缓存和文件产物路由，这些接入细节都由 SDK 统一封装。
const config = loadConfig(process.env);
const executor = new MastraResearchExecutor({
  model: config.model,
  modelStepTimeoutMs: config.modelStepTimeoutMs,
  modelTotalTimeoutMs: config.modelTotalTimeoutMs,
  structuredOutputMode: config.structuredOutputMode,
});
const quickConfig = loadQuickAgentConfig(process.env, 9_303);
const quickArtifactStore = new FileArtifactStore(
  quickConfig.artifactDirectory,
  quickConfig.publicBaseUrl,
);
const quickServer = createQuickAgentServer({
  name: "学术论文写作 Agent",
  ...(quickConfig.apiKey === undefined ? {} : { apiKey: quickConfig.apiKey }),
  artifactStore: quickArtifactStore,
  responseCacheDirectory: quickConfig.responseCacheDirectory,
  executionTimeoutMs: config.executionTimeoutMs,
  execute: createQuickPaperExecutor(executor),
});

quickServer.listen(quickConfig.port, quickConfig.host, () => {
  // 只记录公开地址和模型 ID，绝不输出 API Key 或完整模型配置。
  console.log(
    `学术论文写作 Agent 已监听 ${quickConfig.publicBaseUrl}，模型为 ${config.model.id}`,
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`收到 ${signal}，正在关闭学术论文写作 Agent`);
  // 停止接收新连接，并等待正在写出的响应完成，避免生成到一半的论文被截断。
  quickServer.close((error) => {
    if (error !== undefined) {
      console.error("学术论文写作 Agent 未能正常关闭");
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// 导出稳定业务边界供测试或其他进程内适配器复用；启动入口本身不承载论文生成知识。
export * from "./domain.js";
export { MastraResearchExecutor } from "./mastra-executor.js";
export { OpenAlexClient } from "./openalex.js";
export * from "./quick-paper.js";
export type { ResearchExecutor } from "./research.js";
