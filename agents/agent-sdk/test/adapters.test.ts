import { describe, expect, it, vi } from "vitest";
import { fromLangGraph } from "../src/langgraph.js";
import { fromMastra } from "../src/mastra.js";
import type { AgentExecutionContext } from "../src/runtime.js";

const signal = new AbortController().signal;
const context = {
  task: { title: "开发电商营销首页" },
  workflow: undefined,
  upstreamArtifacts: [],
  callType: "production",
  reworkReason: "强化首屏行动按钮",
  signal,
  reportProgress: async () => undefined,
} satisfies AgentExecutionContext;

describe("可选框架适配器", () => {
  it("把完整执行上下文交给 Mastra，并优先返回结构化对象", async () => {
    const generate = vi.fn(
      async (
        _prompt: string,
        _options?: Readonly<{ abortSignal?: AbortSignal }>,
      ) => ({
        text: "不会覆盖结构化结果",
        object: { sections: ["hero", "social-proof"] },
      }),
    );
    const execute = fromMastra({ generate });

    await expect(execute(context)).resolves.toEqual({
      sections: ["hero", "social-proof"],
    });
    expect(generate).toHaveBeenCalledTimes(1);
    const [serializedInput, options] = generate.mock.calls[0] ?? [];
    expect(JSON.parse(String(serializedInput))).toEqual({
      task: context.task,
      upstreamArtifacts: [],
      reworkReason: "强化首屏行动按钮",
    });
    expect(options).toEqual({ abortSignal: signal });
  });

  it("把任务、上游产物和返工原因交给已编译 LangGraph", async () => {
    const invoke = vi.fn(
      async (
        _input: unknown,
        _options?: Readonly<{ signal?: AbortSignal }>,
      ) => ({ artifact: "homepage.zip" }),
    );
    const execute = fromLangGraph({ invoke });

    await expect(execute(context)).resolves.toEqual({ artifact: "homepage.zip" });
    expect(invoke).toHaveBeenCalledWith(
      {
        task: context.task,
        workflow: undefined,
        upstreamArtifacts: [],
        reworkReason: "强化首屏行动按钮",
      },
      { signal },
    );
  });
});
