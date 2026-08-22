import { ResearchApi } from "./api.js";
import { loadConfig } from "./config.js";
import { MastraResearchExecutor } from "./mastra-executor.js";
import { createResearchServer } from "./server.js";

// 组合根：只在这里连接配置、Mastra 执行器、协议 API 与 Node HTTP Server。
// 各模块因此可以独立测试，不需要在 import 时启动监听端口。
const config = loadConfig(process.env);
const executor = new MastraResearchExecutor({
  model: config.model,
  modelStepTimeoutMs: config.modelStepTimeoutMs,
  modelTotalTimeoutMs: config.modelTotalTimeoutMs,
  structuredOutputMode: config.structuredOutputMode,
});
const api = new ResearchApi({
  agentId: config.agentId,
  secret: config.secret,
  executor,
  executionTimeoutMs: config.executionTimeoutMs,
});
const server = createResearchServer(api);

server.listen(config.port, config.host, () => {
  // 只记录可公开的供应商与模型 ID，绝不输出 apiKey、HMAC secret 或完整模型配置。
  console.log(
    `evidence research agent listening on http://${config.host}:${config.port} using ${config.model.id}`,
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`received ${signal}; shutting down`);
  // 停止接收新连接，并等待 Node 处理现有连接；不强制中断正在写出的响应。
  server.close((error) => {
    if (error !== undefined) {
      console.error("graceful shutdown failed");
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

// 导出稳定边界供契约测试或其他进程内适配器复用；启动入口本身不承载业务知识。
export { ResearchApi } from "./api.js";
export * from "./domain.js";
export { MastraResearchExecutor } from "./mastra-executor.js";
export { OpenAlexClient } from "./openalex.js";
export * from "./protocol.js";
export type { ResearchExecutor } from "./research.js";
