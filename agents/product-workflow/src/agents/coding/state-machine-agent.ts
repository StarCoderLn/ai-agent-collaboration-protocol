import { finalizeArtifact } from "../../domain.js";
import { codeVisualRequirements } from "../../model-client.js";
import {
	codePageGenerationPrompt,
	codePageSystemInstructions,
	codeStylesGenerationPrompt,
	codeStylesSystemInstructions,
} from "../../prompts.js";
import { assertAgentInput, type RunContext, type WorkflowAgentDependencies, type WorkflowExecutor } from "../shared/contracts.js";

/**
 * 可靠前端开发 Agent v2：先验收 TSX，再把该份 TSX 原样交给 CSS 步骤。每段最多进行
 * 一次局部修复；CSS 失败不会重新生成页面，避免已经正确的结构在重试中发生漂移。
 */
export class CodingStateMachineAgent implements WorkflowExecutor {
  constructor(private readonly deps: WorkflowAgentDependencies) {}

  async run(input: Parameters<WorkflowExecutor["run"]>[0], context: RunContext = {}) {
    assertAgentInput(input, "code-state-machine", "code");
	const visualRequirements = codeVisualRequirements(input.design);
	// 初次执行允许每个片段做一次自动局部修复；发布者显式恢复失败节点时，每个片段只
	// 调用一次，确保一次恢复的模型费用固定为最多两次且不会隐藏重复收费。
	const maxAttempts = context.recoveryMode === true ? 1 : 2;
	// 恢复请求中的返工说明已经由正式派发层合并进 userRequest；初次执行与恢复因此走
	// 同一条确定性链路，不依赖 Agent 进程内存，也不会回读上一次不可信模型正文。
	const pageTsx = await this.deps.jsonClient.generateCodePage({
		system: codePageSystemInstructions(),
		prompt: codePageGenerationPrompt(input),
		// 后台管理类页面实测需要 6.3k token 才能闭合完整 TSX；10k 是传输余量而非源码放宽。
		// 提示词把目标压到 12k–16k 字符，产物边界由 Schema 的 30k 硬上限统一约束。
		maxOutputTokens: 10_000,
		maxAttempts,
		visualRequirements,
		...(context.signal === undefined ? {} : { signal: context.signal }),
	});
	const globalsCss = await this.deps.jsonClient.generateCodeStyles({
		system: codeStylesSystemInstructions(),
		// 已通过语法、可见文案与安全边界校验的 TSX 是 CSS 步骤的权威输入。
		prompt: codeStylesGenerationPrompt(input, pageTsx),
		// 一份合规 CSS（12k–20k 字符）需要 4k–7k 输出 token；原 5k 预算会让正常长度的
		// 样式在收尾处被截断。10k 是传输余量，实际长度仍由 CompactCodeStylesSourceSchema
		// 约束，超长由重试的压缩指令纠正，而不是靠截断预算。
		maxOutputTokens: 10_000,
		maxAttempts,
		visualRequirements,
		...(context.signal === undefined ? {} : { signal: context.signal }),
	});
	return finalizeArtifact(input, { pageTsx, globalsCss }, this.deps.now());
  }
}
