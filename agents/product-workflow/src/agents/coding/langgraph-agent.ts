import type { BaseCheckpointSaver } from "@langchain/langgraph";

import { finalizeArtifact } from "../../domain.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";
import { LangGraphCodingFlow } from "./langgraph-coding-flow.js";

/**
 * 正式 LangGraph 候选保持现有 WorkflowExecutor 窄接口。持久状态只包含 Coding 内部
 * 中间产物；任务、分配、结算和返工事实仍由平台数据库管理。
 */
export class CodingLangGraphAgent implements WorkflowExecutor {
  readonly #flow: LangGraphCodingFlow;
  readonly #checkpointer: BaseCheckpointSaver;

  constructor(private readonly deps: WorkflowAgentDependencies, checkpointer: BaseCheckpointSaver) {
    this.#checkpointer = checkpointer;
    this.#flow = new LangGraphCodingFlow(deps.jsonClient, checkpointer);
  }

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "code-langgraph", "code");
    if (context.executionId === undefined || context.executionId.trim() === "") {
      throw new Error("code-langgraph requires a stable executionId");
    }
    const threadId = `code-langgraph:${context.executionId}`;
    const checkpoint = context.recoveryMode === true
      ? await this.#checkpointer.getTuple({ configurable: { thread_id: threadId } })
      : undefined;
    // 平台可能在模型调用前失败，此时 recoveryMode 已开启但还没有图检查点；必须从输入
    // 正常启动。只在确有持久历史时传 null 续跑，避免恢复请求得到空制品。
    const files = checkpoint === undefined
      ? await this.#flow.run(threadId, input, context)
      : await this.#flow.resume(threadId, context);
    return finalizeArtifact(input, files, this.deps.now());
  }
}
