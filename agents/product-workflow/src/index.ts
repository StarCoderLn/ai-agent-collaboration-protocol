import { WorkflowApi } from "./api.js";
import { loadWorkflowAgentConfig } from "./config.js";
import { WorkflowExecutorRouter } from "./executors.js";
import { DeepSeekJsonClient } from "./model-client.js";
import { createWorkflowServer } from "./server.js";

// 组合根只负责连接配置与模块；领域 schema、策略和协议边界都能在不监听端口时测试。
const config = loadWorkflowAgentConfig(process.env);
const jsonClient = new DeepSeekJsonClient({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  modelName: config.modelName,
  timeoutMs: config.modelStepTimeoutMs,
});
const executor = new WorkflowExecutorRouter({
  jsonClient,
  mastraModel: config.mastraModel,
  modelStepTimeoutMs: config.modelStepTimeoutMs,
});
const api = new WorkflowApi({
  secret: config.secret,
  executor,
  executionTimeoutMs: config.executionTimeoutMs,
});
const server = createWorkflowServer(api);

server.listen(config.port, config.host, () => {
  console.log(
    `product workflow agents listening on http://${config.host}:${config.port} using deepseek/${config.modelName}`,
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`received ${signal}; shutting down product workflow agents`);
  server.close((error) => {
    if (error !== undefined) {
      console.error("workflow agent graceful shutdown failed");
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

export * from "./catalog.js";
export * from "./domain.js";
export * from "./formal-dispatch.js";
export { WorkflowApi } from "./api.js";
export { WorkflowExecutorRouter } from "./executors.js";
