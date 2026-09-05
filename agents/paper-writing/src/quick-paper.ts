import { createHash } from "node:crypto";
import type { QuickAgentExecutor, QuickRunRequest } from "@aicp/agent-sdk";
import type { ResearchReport, ResearchTaskInput } from "./domain.js";
import type { ResearchExecutor } from "./research.js";

/**
 * 把平台通用输入适配成论文写作输入。标题是唯一业务必填项，详细需求和验收标准只用于
 * 补充论文关注点；默认字数与来源数由 Agent 自己承担，不转嫁给普通用户。
 */
export function createQuickPaperExecutor(executor: ResearchExecutor): QuickAgentExecutor {
  return async (request, signal) => {
    const report = await executor.run(toResearchInput(request), { signal });
    return {
      status: "completed",
      artifacts: [{
        type: "document",
        summary: `《${report.title}》论文初稿`,
        content: renderPaperMarkdown(report),
        mimeType: "text/markdown",
      }],
    };
  };
}

export function toResearchInput(request: QuickRunRequest): ResearchTaskInput {
  const title = request.task.title?.trim();
  if (title === undefined || title.length < 3) {
    throw new Error("论文标题至少需要 3 个字符");
  }
  const detail = [request.task.description, request.task.acceptanceCriteria]
    .filter((value): value is string => value !== undefined && value.trim().length > 0)
    .join("\n");
  return {
    schemaVersion: "paper.research.v0.1",
    // 平台未传 task.id 时以内容生成稳定标识，保证同一输入在日志和报告中可关联。
    taskId: request.task.id ?? `quick-${createHash("sha256").update(`${title}\n${detail}`).digest("hex").slice(0, 20)}`,
    topic: title,
    researchQuestion: detail.length >= 10
      ? detail.slice(0, 2_000)
      : `围绕“${title}”提出清晰论点，并基于可核查学术证据完成论文初稿。`,
    language: "zh-CN",
    targetWords: 1_800,
    sourceCount: 8,
  };
}

/** 把结构化研究结果渲染成用户可直接阅读的论文，不把内部 JSON 当作主要交付物。 */
export function renderPaperMarkdown(report: ResearchReport): string {
  const sourceNumbers = new Map(report.sources.map((source, index) => [source.id, index + 1]));
  const sections = report.sections.map((section) => {
    const citations = [...new Set(section.citationIds)]
      .map((id) => sourceNumbers.get(id))
      .filter((number): number is number => number !== undefined)
      .map((number) => `[${number}]`)
      .join("");
    return `## ${section.heading}\n\n${section.content}${citations ? ` ${citations}` : ""}`;
  });
  const references = report.sources.map((source, index) => {
    const authors = source.authors.length > 0 ? source.authors.join(", ") : "作者信息缺失";
    const year = source.publicationYear ?? "年份缺失";
    return `[${index + 1}] ${authors}. ${source.title}. ${year}. ${source.doi ?? source.url}`;
  });
  const limitations = report.limitations.length > 0
    ? report.limitations.map((limitation) => `- ${limitation}`).join("\n")
    : "- 本文是基于有限公开元数据生成的初稿，提交或发表前仍需作者复核全文证据。";
  return [
    `# ${report.title}`,
    `> 生成时间：${report.generatedAt.slice(0, 10)} · 基于 ${report.sources.length} 条可追溯学术来源`,
    "## 摘要",
    report.executiveSummary,
    ...sections,
    "## 研究限制",
    limitations,
    "## 参考文献",
    references.join("\n\n"),
  ].join("\n\n");
}
