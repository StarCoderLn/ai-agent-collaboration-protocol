import { ErrorCategory, ErrorDomain, MastraError } from "@mastra/core/error";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mastraMock = vi.hoisted(() => ({
  prompts: [] as string[],
  responses: [] as Array<MastraResponse | Error>,
}));

vi.mock("@mastra/core/agent", () => ({
  Agent: class {
    async generate(prompt: string): Promise<MastraResponse> {
      mastraMock.prompts.push(prompt);
      const response = mastraMock.responses.shift();
      if (response === undefined) throw new Error("测试没有配置 Mastra 响应");
      if (response instanceof Error) throw response;
      return response;
    }
  },
}));

import {
  generateValidatedTextWithMastra,
  planWithMastra,
} from "../src/agents/shared/model-steps.js";

type MastraResponse = Readonly<{
  object?: unknown | undefined;
  text: string;
  error?: Error | undefined;
}>;

const VALID_ANALYSIS = {
  risks: ["输入信息可能不完整"],
  coverage: ["覆盖用户主流程"],
  plan: ["生成可执行需求"],
};

describe("Mastra 模型步骤", () => {
  beforeEach(() => {
    mastraMock.prompts.length = 0;
    mastraMock.responses.length = 0;
  });

  it("严格结构化输出首次缺字段时重新生成完整对象", async () => {
    mastraMock.responses.push({ text: "", error: structuredOutputError() }, {
      object: VALID_ANALYSIS,
      text: JSON.stringify(VALID_ANALYSIS),
    });

    const result = await planWithMastra(
      requirementsInput(),
      "deepseek/test",
      1_000,
      {},
    );

    expect(result).toEqual(VALID_ANALYSIS);
    expect(mastraMock.prompts).toHaveLength(2);
    expect(mastraMock.prompts[1]).toContain("prior response failed strict schema validation");
  });

  it("Mastra 未上报错误但对象实际缺字段时仍会修复", async () => {
    mastraMock.responses.push({
      object: { risks: ["输入信息可能不完整"] },
      text: JSON.stringify({ risks: ["输入信息可能不完整"] }),
    }, {
      object: VALID_ANALYSIS,
      text: JSON.stringify(VALID_ANALYSIS),
    });

    await expect(planWithMastra(
      requirementsInput(),
      "deepseek/test",
      1_000,
      {},
    )).resolves.toEqual(VALID_ANALYSIS);
    expect(mastraMock.prompts).toHaveLength(2);
  });

  it("Coding 文本首次未通过可信校验时只重新生成一次", async () => {
    const prompts: string[] = [];
    const responses: MastraResponse[] = [
      { text: "不完整代码" },
      { text: "export default function Page() { return <main>可执行页面</main>; }" },
    ];
    const result = await generateValidatedTextWithMastra(
      async (prompt) => {
        prompts.push(prompt);
        const response = responses.shift();
        if (response === undefined) throw new Error("测试没有配置 Coding 响应");
        return response;
      },
      "生成 app/page.tsx",
      (text) => z.string().min(50).startsWith("export default").parse(text),
      "A prior TSX response failed static validation.",
    );

    expect(result).toContain("export default function Page");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("failed static validation");
  });

  it("第二次结构化输出仍不合法时保留原始失败", async () => {
    const firstError = structuredOutputError();
    const finalError = structuredOutputError();
    mastraMock.responses.push(firstError, finalError);

    await expect(planWithMastra(
      requirementsInput(),
      "deepseek/test",
      1_000,
      {},
    )).rejects.toBe(finalError);
    expect(mastraMock.prompts).toHaveLength(2);
  });

  it("网络等非输出校验错误不会被误重试", async () => {
    const providerError = new Error("provider unavailable");
    mastraMock.responses.push(providerError);

    await expect(planWithMastra(
      requirementsInput(),
      "deepseek/test",
      1_000,
      {},
    )).rejects.toBe(providerError);
    expect(mastraMock.prompts).toHaveLength(1);
  });
});

function structuredOutputError(): MastraError {
  return new MastraError({
    id: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
    domain: ErrorDomain.AGENT,
    category: ErrorCategory.USER,
    text: "结构化输出缺少必填字段",
  });
}

function requirementsInput() {
  return {
    schemaVersion: "workflow.execute.v0.1" as const,
    taskId: "task-mastra-repair",
    step: "requirements" as const,
    agentId: "prd-mastra" as const,
    userRequest: "开发一条可选择不同 Agent 的产品工作流。",
  };
}
