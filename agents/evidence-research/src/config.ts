import { z } from "zod";

// 环境变量属于不可信外部输入：在进程启动边界一次性校验，内部代码只接收 AgentConfig。
const EnvironmentSchema = z.object({
  EVIDENCE_AGENT_ID: z.string().min(1).default("evidence-research-agent"),
  EVIDENCE_AGENT_SECRET: z.string().min(16),
  EVIDENCE_AGENT_PROVIDER: z.enum(["ollama", "deepseek"]).default("ollama"),
  EVIDENCE_AGENT_MODEL: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.url().default("http://127.0.0.1:11434/v1"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
  EVIDENCE_AGENT_HOST: z.string().min(1).default("127.0.0.1"),
  EVIDENCE_AGENT_PORT: z.coerce.number().int().min(1).max(65_535).default(9201),
});

export type OpenAICompatibleModelConfig = {
  /** Mastra 的 OpenAI-compatible 路由要求 provider/model 两段式 ID。 */
  id: `${"ollama" | "deepseek"}/${string}`;
  /** 供应商暴露的 OpenAI-compatible API 根地址。 */
  url: string;
  /** 仅云端模型需要；Ollama 配置不生成这个字段。 */
  apiKey?: string;
};

export type EvidenceAgentProvider = "ollama" | "deepseek";

export type AgentConfig = {
  /** 平台协议和健康检查中对外稳定展示的 Agent 标识。 */
  agentId: string;
  /** HMAC 共享密钥，只用于服务端验签，禁止返回给浏览器或写入日志。 */
  secret: string;
  provider: EvidenceAgentProvider;
  /** Mastra 使用的 OpenAI-compatible 模型配置。 */
  model: OpenAICompatibleModelConfig;
  /** 模型单步最长时间；本地 CPU 与云端分别使用不同基线。 */
  modelStepTimeoutMs: number;
  /** Mastra 一次完整工具循环允许的最长时间。 */
  modelTotalTimeoutMs: number;
  /** HTTP 层截止时间必须略大于模型截止时间，才能正常返回模型结果。 */
  executionTimeoutMs: number;
  /** DeepSeek 不使用严格 json_schema 响应格式，改由提示注入并在本地 Zod 校验。 */
  structuredOutputMode: "native" | "prompt";
  host: string;
  port: number;
};

export function loadConfig(environment: NodeJS.ProcessEnv): AgentConfig {
  // parse 会聚合字段级错误，并在创建网络监听和模型实例前终止启动。
  const parsed = EnvironmentSchema.parse(environment);
  if (parsed.EVIDENCE_AGENT_PROVIDER === "deepseek") {
    if (parsed.DEEPSEEK_API_KEY === undefined) {
      throw new Error("DEEPSEEK_API_KEY is required when EVIDENCE_AGENT_PROVIDER=deepseek");
    }
    const modelName = stripProviderPrefix(
      parsed.EVIDENCE_AGENT_MODEL ?? "deepseek-v4-flash",
      "deepseek",
    );
    return {
      agentId: parsed.EVIDENCE_AGENT_ID,
      secret: parsed.EVIDENCE_AGENT_SECRET,
      provider: "deepseek",
      model: {
        id: `deepseek/${modelName}`,
        url: normalizeBaseUrl(parsed.DEEPSEEK_BASE_URL, "DEEPSEEK_BASE_URL"),
        apiKey: parsed.DEEPSEEK_API_KEY,
      },
      // DeepSeek V4 Flash 在包含结构化长输出时实测可能超过 60 秒；两阶段流程还包含一次
      // 短检索规划调用，因此 HTTP 总截止时间必须覆盖两个模型阶段和 OpenAlex 网络时间。
      modelStepTimeoutMs: 120_000,
      modelTotalTimeoutMs: 180_000,
      executionTimeoutMs: 240_000,
      structuredOutputMode: "prompt",
      host: parsed.EVIDENCE_AGENT_HOST,
      port: parsed.EVIDENCE_AGENT_PORT,
    };
  }

  const modelName = stripProviderPrefix(
    parsed.EVIDENCE_AGENT_MODEL ?? "gemma4:latest",
    "ollama",
  );
  return {
    agentId: parsed.EVIDENCE_AGENT_ID,
    secret: parsed.EVIDENCE_AGENT_SECRET,
    provider: "ollama",
    model: {
      id: `ollama/${modelName}`,
      url: normalizeBaseUrl(parsed.OLLAMA_BASE_URL, "OLLAMA_BASE_URL"),
    },
    // 本机 CPU 生成一次工具调用可能超过一分钟；云端默认值不适用于本地推理。
    modelStepTimeoutMs: 360_000,
    modelTotalTimeoutMs: 900_000,
    executionTimeoutMs: 960_000,
    structuredOutputMode: "native",
    host: parsed.EVIDENCE_AGENT_HOST,
    port: parsed.EVIDENCE_AGENT_PORT,
  };
}

function stripProviderPrefix(
  model: string,
  provider: EvidenceAgentProvider,
): string {
  const prefix = `${provider}/`;
  const normalized = model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (normalized.length === 0) {
    throw new Error(`EVIDENCE_AGENT_MODEL must include a ${provider} model name`);
  }
  return normalized;
}

function normalizeBaseUrl(value: string, variableName: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${variableName} must use http or https`);
  }
  // Mastra 会在该根地址下追加 chat/completions；去掉结尾斜线避免双斜线。
  return url.toString().replace(/\/$/, "");
}
