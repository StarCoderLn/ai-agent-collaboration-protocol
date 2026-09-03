import type { AgentExecutionContext, AgentExecutor } from "./runtime.js";

/** 只依赖 Mastra Agent 的稳定结构，不把 @mastra/core 强制安装给通用 SDK 用户。 */
export type MastraAgentLike = Readonly<{
  generate(
    prompt: string,
    options?: Readonly<{ abortSignal?: AbortSignal }>,
  ): Promise<Readonly<{ text?: string; object?: unknown }>>;
}>;

/** 把 Mastra 的 generate 接口转换成 AICP execute，不复制任何协议或回调代码。 */
export function fromMastra(agent: MastraAgentLike): AgentExecutor {
  return async (context: AgentExecutionContext) => {
    const result = await agent.generate(
      JSON.stringify({
        task: context.task,
        workflow: context.workflow,
        upstreamArtifacts: context.upstreamArtifacts,
        ...(context.reworkReason === undefined ? {} : { reworkReason: context.reworkReason }),
      }),
      { abortSignal: context.signal },
    );
    return result.object ?? result.text;
  };
}
