import { z } from "zod";

const EnvironmentSchema = z.object({
  DATABASE_URL: z.url(),
  WORKFLOW_MODEL_PROVIDER: z.enum(["deepseek", "openai"]).optional(),
  WORKFLOW_MODEL_API_KEY: z.string().min(1).optional(),
  WORKFLOW_MODEL_BASE_URL: z.url().optional(),
  // 旧变量继续作为兼容输入；统一变量一旦配置便具有更高优先级。
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  DEEPSEEK_BASE_URL: z.url().optional(),
  // 工作流要求稳定输出严格 JSON；默认使用非推理 chat 模型，避免 reasoning token
  // 挤占代码制品的输出预算。需要其他模型时仍可通过服务专属变量显式覆盖。
  WORKFLOW_AGENT_MODEL: z.string().min(1).optional(),
  WORKFLOW_AGENT_SECRET: z.string().min(16),
  WORKFLOW_AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  WORKFLOW_AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(9202),
});

export type WorkflowAgentConfig = {
  provider: "deepseek" | "openai";
  databaseUrl: string;
  apiKey: string;
  baseUrl: string;
  modelName: string;
  mastraModel: {
    id: `${"deepseek" | "openai"}/${string}`;
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
  const provider = parsed.WORKFLOW_MODEL_PROVIDER ?? "deepseek";
  const apiKey =
    parsed.WORKFLOW_MODEL_API_KEY ??
    (provider === "deepseek" ? parsed.DEEPSEEK_API_KEY : undefined);
  if (apiKey === undefined) {
    throw new Error("WORKFLOW_MODEL_API_KEY is required");
  }
  const baseUrl = normalizeBaseUrl(
    parsed.WORKFLOW_MODEL_BASE_URL ??
      (provider === "deepseek" ? parsed.DEEPSEEK_BASE_URL : undefined) ??
      (provider === "openai" ? "https://api.openai.com/v1" : "https://api.deepseek.com"),
  );
  const modelName = stripProviderPrefix(
    parsed.WORKFLOW_AGENT_MODEL ?? (provider === "openai" ? "gpt-5-mini" : "deepseek-chat"),
    provider,
  );
  return {
    provider,
    databaseUrl: parsed.DATABASE_URL,
    apiKey,
    baseUrl,
    modelName,
    mastraModel: {
      id: `${provider}/${modelName}`,
      url: baseUrl,
      apiKey,
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
    throw new Error("WORKFLOW_MODEL_BASE_URL must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

function stripProviderPrefix(value: string, provider: "deepseek" | "openai"): string {
  const prefix = `${provider}/`;
  const model = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (model.length === 0) {
    throw new Error("WORKFLOW_AGENT_MODEL must include a model name");
  }
  return model;
}
