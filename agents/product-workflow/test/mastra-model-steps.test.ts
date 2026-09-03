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
  controlledMastraOutputTokenBudget,
  generateStructuredWithMastra,
  generateValidatedTextWithMastra,
  planWithMastra,
} from "../src/agents/shared/model-steps.js";
import { ModelOutputError } from "../src/model-client.js";

type MastraResponse = Readonly<{
  object?: unknown | undefined;
  text: string;
  error?: Error | undefined;
  finishReason?: string | undefined;
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

	it("只有明确截断后的第二次尝试才扩大输出预算", () => {
	  expect(controlledMastraOutputTokenBudget(7_000, 0, "MODEL_OUTPUT_INVALID")).toBe(7_000);
	  expect(controlledMastraOutputTokenBudget(7_000, 1, "MODEL_OUTPUT_INVALID")).toBe(7_000);
	  expect(controlledMastraOutputTokenBudget(7_000, 1, "MODEL_OUTPUT_TRUNCATED")).toBe(8_000);
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

	it("Mastra 严格校验失败时重新校验内存对象并只传递安全诊断", async () => {
	  const schema = z.object({ pages: z.array(z.string()).min(1) }).strict();
	  const prompts: string[] = [];
	  const responses: MastraResponse[] = [
		{ text: "", error: structuredOutputError(JSON.stringify({ pages: [] })) },
		{ object: { pages: ["首页"] }, text: "" },
	  ];

	  await expect(generateStructuredWithMastra(
		async (prompt) => {
		  prompts.push(prompt);
		  const response = responses.shift();
		  if (response === undefined) throw new Error("测试响应不足");
		  return response;
		},
		"生成设计结构",
		schema,
		"design_draft",
	  )).resolves.toEqual({ pages: ["首页"] });
	  expect(prompts[1]).toContain("pages:too_small");
	  expect(prompts[1]).not.toContain("首页");
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
	  "code_page",
    );

    expect(result).toContain("export default function Page");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("failed static validation");
  });

  it("规划第二次结构化输出仍不合法时返回安全的阶段诊断", async () => {
    const firstError = structuredOutputError();
    const finalError = structuredOutputError();
    mastraMock.responses.push(firstError, finalError);

    await expect(planWithMastra(
      requirementsInput(),
      "deepseek/test",
      1_000,
      {},
	)).rejects.toMatchObject({
	  code: "MODEL_OUTPUT_INVALID",
	  validationStage: "analysis",
	  issues: [{ path: "<root>", code: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED" }],
	});
    expect(mastraMock.prompts).toHaveLength(2);
  });

	it("设计结构失败时只保留字段路径和稳定校验码", async () => {
	  const schema = z.object({ pages: z.array(z.object({ title: z.string().min(1) })).min(1) }).strict();
	  const generate = vi.fn().mockResolvedValue({ object: { pages: [{ title: "" }] }, text: "" });

	  let caught: unknown;
	  try {
		await generateStructuredWithMastra(generate, "生成设计结构", schema, "design_draft");
	  } catch (error) { caught = error; }

	  expect(caught).toBeInstanceOf(ModelOutputError);
	  expect(caught).toMatchObject({
		validationStage: "design_draft",
		issues: [{ path: "pages.0.title", code: "too_small" }],
	  });
	  expect((caught as Error).message).not.toContain("生成设计结构");
	  expect(generate).toHaveBeenCalledTimes(2);
	});

	it("代码页面损坏时能够与设计结构失败区分", async () => {
	  const generate = vi.fn().mockResolvedValue({ text: "没有合法的代码页面" });

	  await expect(generateValidatedTextWithMastra(
		generate,
		"生成可运行页面",
		() => { throw new z.ZodError([{ code: "custom", path: [], message: "DESIGN_ID_COVERAGE_MISSING" }]); },
		"重新生成完整页面",
		"code_page",
	  )).rejects.toMatchObject({
		code: "MODEL_OUTPUT_INVALID",
		validationStage: "code_page",
		issues: [{ path: "<root>", code: "DESIGN_ID_COVERAGE_MISSING" }],
	  });
	  expect(generate).toHaveBeenCalledTimes(2);
	});

	it("代码页面达到 token 上限时保留截断类别并要求输出完整源码", async () => {
	  const prompts: string[] = [];
	  await expect(generateValidatedTextWithMastra(
		async (prompt) => {
		  prompts.push(prompt);
		  return { text: "不完整页面", finishReason: "length" };
		},
		"生成可运行页面",
		() => { throw new z.ZodError([{ code: "custom", path: [], message: "TSX_SYNTAX_INVALID" }]); },
		"重新生成完整页面",
		"code_page",
	  )).rejects.toMatchObject({
		code: "MODEL_OUTPUT_TRUNCATED",
		validationStage: "code_page",
	  });
	  expect(prompts[1]).toContain("reached the output-token limit");
	  expect(prompts[1]).toContain("complete source section");
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

function structuredOutputError(serializedValue?: string): MastraError {
  return new MastraError({
    id: "STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED",
    domain: ErrorDomain.AGENT,
    category: ErrorCategory.USER,
    text: "结构化输出缺少必填字段",
	...(serializedValue === undefined ? {} : { details: { value: serializedValue } }),
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
