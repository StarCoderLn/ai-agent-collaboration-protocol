import { z } from "zod";

// 环境变量属于不可信外部输入：在进程启动边界一次性校验，内部代码只接收 AgentConfig。
const EnvironmentSchema = z.object({
  PAPER_AGENT_PROVIDER: z.enum(["ollama", "deepseek"]).default("ollama"),
  PAPER_AGENT_MODEL: z.string().min(1).optional(),
  OLLAMA_BASE_URL: z.url().default("http://127.0.0.1:11434/v1"),
  DEEPSEEK_BASE_URL: z.url().default("https://api.deepseek.com"),
  DEEPSEEK_API_KEY: z.string().min(1).optional(),
});

export type OpenAICompatibleModelConfig = {
  /** Mastra 的 OpenAI-compatible 路由要求 provider/model 两段式 ID。 */
  id: `${"ollama" | "deepseek"}/${string}`;
  /** 供应商暴露的 OpenAI-compatible API 根地址。 */
  url: string;
  /** 仅云端模型需要；Ollama 配置不生成这个字段。 */
  apiKey?: string;
};

export type PaperAgentProvider = "ollama" | "deepseek";

export type AgentConfig = {
  provider: PaperAgentProvider;
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
};

export function loadConfig(environment: NodeJS.ProcessEnv): AgentConfig {
  // parse 会聚合字段级错误，并在创建网络监听和模型实例前终止启动。
  const parsed = EnvironmentSchema.parse(environment);
  if (parsed.PAPER_AGENT_PROVIDER === "deepseek") {
    if (parsed.DEEPSEEK_API_KEY === undefined) {
      throw new Error("DEEPSEEK_API_KEY is required when PAPER_AGENT_PROVIDER=deepseek");
    }
    const modelName = stripProviderPrefix(
      // 论文正文最终要形成严格 JSON。推理模型可能先耗尽 reasoning token，导致正文为空；
      // 默认使用非推理 chat 模型，把输出预算稳定留给论文内容和结构化字段。
      parsed.PAPER_AGENT_MODEL ?? "deepseek-chat",
      "deepseek",
    );
    return {
      provider: "deepseek",
      model: {
        id: `deepseek/${modelName}`,
        url: normalizeBaseUrl(parsed.DEEPSEEK_BASE_URL, "DEEPSEEK_BASE_URL"),
        apiKey: parsed.DEEPSEEK_API_KEY,
      },
      // 两阶段流程包含一次短检索规划和一次长论文写作，因此 HTTP 总截止时间必须覆盖
      // 两个模型阶段与 OpenAlex 网络时间，不能只按单次 chat 请求设置。
      modelStepTimeoutMs: 120_000,
      modelTotalTimeoutMs: 180_000,
      executionTimeoutMs: 240_000,
      structuredOutputMode: "prompt",
    };
  }

  const modelName = stripProviderPrefix(
    parsed.PAPER_AGENT_MODEL ?? "gemma4:latest",
    "ollama",
  );
  return {
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
  };
}

function stripProviderPrefix(
  model: string,
  provider: PaperAgentProvider,
): string {
  const prefix = `${provider}/`;
  const normalized = model.startsWith(prefix) ? model.slice(prefix.length) : model;
  if (normalized.length === 0) {
    throw new Error(`PAPER_AGENT_MODEL must include a ${provider} model name`);
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
