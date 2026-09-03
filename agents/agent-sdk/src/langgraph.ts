import type { AgentExecutionContext, AgentExecutor } from "./runtime.js";

/** LangGraph 适配器只要求可调用图，不把具体 State 或消息实现泄漏进协议核心。 */
export type LangGraphLike = Readonly<{
  invoke(input: unknown, options?: Readonly<{ signal?: AbortSignal }>): Promise<unknown>;
}>;

/** 把已编译 LangGraph 的 invoke 接口转换成 AICP execute。 */
export function fromLangGraph(graph: LangGraphLike): AgentExecutor {
  return async (context: AgentExecutionContext) =>
    graph.invoke(
      {
        task: context.task,
        workflow: context.workflow,
        upstreamArtifacts: context.upstreamArtifacts,
        ...(context.reworkReason === undefined ? {} : { reworkReason: context.reworkReason }),
      },
      { signal: context.signal },
    );
}
