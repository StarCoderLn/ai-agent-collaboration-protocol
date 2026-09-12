import { z } from "zod";

const EnvironmentSchema = z.object({
  DATABASE_URL: z.url(),
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  // 工作流要求稳定输出严格 JSON；默认使用非推理 chat 模型，避免 reasoning token
  // 挤占代码制品的输出预算。需要其他模型时仍可通过服务专属变量显式覆盖。
  WORKFLOW_AGENT_MODEL: z.string().min(1).default("deepseek-chat"),
  WORKFLOW_AGENT_SECRET: z.string().min(16),
  WORKFLOW_AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  WORKFLOW_AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(9202),
});

export type WorkflowAgentConfig = {
  databaseUrl: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  mastraModel: {
    id: `deepseek/${string}`;
    url: string;
    apiKey: string;
  };
  secret: string;
  host: string;
  port: number;
  modelStepTimeoutMs: number;
  executionTimeoutMs: number;
};

export function loadWorkflowAgentConfig(environment: NodeJS.ProcessEnv): WorkflowAgentConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const baseUrl = normalizeBaseUrl(parsed.DEEPSEEK_BASE_URL);
  const modelName = stripProviderPrefix(parsed.WORKFLOW_AGENT_MODEL);
  return {
    databaseUrl: parsed.DATABASE_URL,
    apiKey: parsed.DEEPSEEK_API_KEY,
    baseUrl,
    modelName,
    mastraModel: {
      id: `deepseek/${modelName}`,
      url: baseUrl,
      apiKey: parsed.DEEPSEEK_API_KEY,
    },
    secret: parsed.WORKFLOW_AGENT_SECRET,
    host: parsed.WORKFLOW_AGENT_HOST,
    port: parsed.WORKFLOW_AGENT_PORT,
    modelStepTimeoutMs: 120_000,
    // 状态机最多执行分析、生成、评审和一次修复，因此 HTTP 截止时间高于单步时间。
    executionTimeoutMs: 420_000,
  };
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("DEEPSEEK_BASE_URL must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

function stripProviderPrefix(value: string): string {
  const model = value.startsWith("deepseek/") ? value.slice("deepseek/".length) : value;
  if (model.length === 0) {
    throw new Error("WORKFLOW_AGENT_MODEL must include a model name");
  }
  return model;
}
