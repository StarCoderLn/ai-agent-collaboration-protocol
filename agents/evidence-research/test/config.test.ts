import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const requiredEnvironment = {
  EVIDENCE_AGENT_SECRET: "local-test-signing-secret",
};

describe("loadConfig", () => {
  it("defaults to the locally installed Ollama model without requiring a cloud key", () => {
    const config = loadConfig(requiredEnvironment);

    expect(config).toMatchObject({
      provider: "ollama",
      model: {
        id: "ollama/gemma4:latest",
        url: "http://127.0.0.1:11434/v1",
      },
      modelStepTimeoutMs: 360_000,
      modelTotalTimeoutMs: 900_000,
      executionTimeoutMs: 960_000,
      structuredOutputMode: "native",
    });
  });

  it("normalizes an optional ollama prefix and a trailing base-url slash", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      EVIDENCE_AGENT_MODEL: "ollama/qwen3:8b",
      OLLAMA_BASE_URL: "http://localhost:11434/v1/",
    });

    expect(config.model).toEqual({
      id: "ollama/qwen3:8b",
      url: "http://localhost:11434/v1",
    });
  });

  it("builds a low-latency DeepSeek config when its server-side key exists", () => {
    const config = loadConfig({
      ...requiredEnvironment,
      EVIDENCE_AGENT_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "deepseek-test-key",
    });

    expect(config).toMatchObject({
      provider: "deepseek",
      model: {
        id: "deepseek/deepseek-v4-flash",
        url: "https://api.deepseek.com",
        apiKey: "deepseek-test-key",
      },
      modelStepTimeoutMs: 120_000,
      modelTotalTimeoutMs: 180_000,
      executionTimeoutMs: 240_000,
      structuredOutputMode: "prompt",
    });
  });

  it("rejects DeepSeek mode before startup when its key is missing", () => {
    expect(() =>
      loadConfig({ ...requiredEnvironment, EVIDENCE_AGENT_PROVIDER: "deepseek" }),
    ).toThrow("DEEPSEEK_API_KEY is required");
  });
});
