import { describe, expect, it } from "vitest";
import { loadWorkflowAgentConfig } from "../src/config.js";

const base = {
  DATABASE_URL: "postgres://localhost/aicp",
  WORKFLOW_AGENT_SECRET: "0123456789abcdef",
};

describe("workflow model config", () => {
  it("兼容既有 DeepSeek 变量", () => {
    const config = loadWorkflowAgentConfig({
      ...base,
      DEEPSEEK_API_KEY: "legacy-key",
    });
    expect(config).toMatchObject({
      provider: "deepseek",
      modelName: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      apiKey: "legacy-key",
    });
  });

  it("只改统一配置即可切换 OpenAI", () => {
    const config = loadWorkflowAgentConfig({
      ...base,
      WORKFLOW_MODEL_PROVIDER: "openai",
      WORKFLOW_MODEL_API_KEY: "openai-key",
      WORKFLOW_MODEL_BASE_URL: "https://api.openai.com/v1",
      WORKFLOW_AGENT_MODEL: "openai/gpt-5-mini",
    });
    expect(config).toMatchObject({
      provider: "openai",
      modelName: "gpt-5-mini",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "openai-key",
    });
    expect(config.mastraModel.id).toBe("openai/gpt-5-mini");
  });

  it("切换到 OpenAI 时不会误用遗留的 DeepSeek 密钥", () => {
    expect(() =>
      loadWorkflowAgentConfig({
        ...base,
        WORKFLOW_MODEL_PROVIDER: "openai",
        DEEPSEEK_API_KEY: "legacy-deepseek-key",
      }),
    ).toThrow("WORKFLOW_MODEL_API_KEY is required");
  });
});
