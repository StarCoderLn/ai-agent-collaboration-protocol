import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

import { WorkflowApi } from "./api.js";
import { loadWorkflowAgentConfig } from "./config.js";
import { WorkflowExecutorRouter } from "./executors.js";
import { OpenAICompatibleModelClient } from "./model-client.js";
import { LangGraphWorkflowPlanner } from "./planning/langgraph-workflow-planner.js";
import { createWorkflowServer } from "./server.js";

// 组合根只负责连接配置与模块；领域 schema、策略和协议边界都能在不监听端口时测试。
const config = loadWorkflowAgentConfig(process.env);
const modelClient = new OpenAICompatibleModelClient({
  baseUrl: config.baseUrl,
  apiKey: config.apiKey,
  modelName: config.modelName,
  timeoutMs: config.modelStepTimeoutMs,
});
const langGraphCheckpointer = PostgresSaver.fromConnString(config.databaseUrl, {
  schema: "langgraph",
});
// 官方 setup 自带版本表并可重复执行；独立 schema 避免把框架表混入业务 migration 权威范围。
await langGraphCheckpointer.setup();
const executor = new WorkflowExecutorRouter({
  jsonClient: modelClient,
  mastraModel: config.mastraModel,
  modelStepTimeoutMs: config.modelStepTimeoutMs,
  langGraphCheckpointer,
});
const workflowPlanner = new LangGraphWorkflowPlanner(modelClient, langGraphCheckpointer);
const api = new WorkflowApi({
  secret: config.secret,
  executor,
  executionTimeoutMs: config.executionTimeoutMs,
  workflowPlanner,
  plannerModel: { provider: config.provider, model: config.modelName },
});
const server = createWorkflowServer(api);

server.listen(config.port, config.host, () => {
  console.log(
    `product workflow agents listening on http://${config.host}:${config.port} using ${config.provider}/${config.modelName}`,
  );
});

const shutdown = (signal: NodeJS.Signals) => {
  console.log(`received ${signal}; shutting down product workflow agents`);
  server.close((error) => {
    if (error !== undefined) {
      console.error("workflow agent graceful shutdown failed");
      process.exitCode = 1;
    }
    void langGraphCheckpointer.end();
  });
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

export * from "./catalog.js";
export * from "./domain.js";
export * from "./formal-dispatch.js";
export { WorkflowApi } from "./api.js";
export { WorkflowExecutorRouter } from "./executors.js";
export * from "./planning/workflow-plan.js";
