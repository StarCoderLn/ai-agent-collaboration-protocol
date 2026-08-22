import type { DraftResearchReport, ResearchReport, ResearchTaskInput } from "./domain.js";

/** 执行期控制信息，不属于可持久化的业务输入。 */
export type ResearchExecutionContext = {
  signal?: AbortSignal;
};

/**
 * API 层依赖的深接口：调用方只关心“输入 -> 最终报告”，不需要了解 Mastra、OpenAlex、
 * 模型供应商、工具循环或引用白名单的内部细节。
 */
export interface ResearchExecutor {
  run(input: ResearchTaskInput, context?: ResearchExecutionContext): Promise<ResearchReport>;
}

/** 可用于测试或未来非 Mastra 实现的最小草稿生成函数类型。 */
export type DraftGenerator = (
  prompt: string,
  context?: ResearchExecutionContext,
) => Promise<DraftResearchReport>;
