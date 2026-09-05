import { describe, expect, it } from "vitest";
import type { ResearchReport } from "../src/domain.js";
import { createQuickPaperExecutor, renderPaperMarkdown, toResearchInput } from "../src/quick-paper.js";
import type { ResearchExecutor } from "../src/research.js";

const report: ResearchReport = {
  schemaVersion: "paper.report.v0.1",
  taskId: "task-1",
  title: "可信多 Agent 协作研究",
  executiveSummary: "本文研究可信协作机制。",
  sections: [
    { heading: "问题背景", content: "多 Agent 协作存在信任问题。", citationIds: ["source-1"] },
    { heading: "机制分析", content: "可审计协议能够降低风险。", citationIds: ["source-1"] },
  ],
  limitations: ["公开摘要不足以替代全文阅读。"],
  sources: [{
    id: "source-1",
    title: "Agent Collaboration",
    authors: ["Ada"],
    publicationYear: 2025,
    doi: "https://doi.org/10.1/example",
    url: "https://example.test/paper",
  }],
  generatedAt: "2026-09-04T00:00:00.000Z",
};

describe("论文 Agent 快速接入适配器", () => {
  it("只凭论文标题即可形成有界的研究任务", () => {
    const input = toResearchInput({ task: { title: "可信多 Agent 协作" }, upstreamArtifacts: [] });
    expect(input.topic).toBe("可信多 Agent 协作");
    expect(input.sourceCount).toBe(8);
    expect(input.researchQuestion).toContain("可信多 Agent 协作");
  });

  it("向平台返回可直接阅读的 Markdown，而不是原始 JSON", async () => {
    const executor: ResearchExecutor = { run: async () => report };
    const result = await createQuickPaperExecutor(executor)(
      { task: { id: "task-1", title: "可信多 Agent 协作" }, upstreamArtifacts: [] },
      new AbortController().signal,
    );
    expect(result.artifacts[0]).toMatchObject({ type: "document", mimeType: "text/markdown" });
    expect(result.artifacts[0]?.content).toContain("## 参考文献");
    expect(result.artifacts[0]?.content).toContain("[1] Ada");
  });

  it("将章节引用映射到可核对的参考文献序号", () => {
    const markdown = renderPaperMarkdown(report);
    expect(markdown).toContain("多 Agent 协作存在信任问题。 [1]");
    expect(markdown).toContain("https://doi.org/10.1/example");
  });
});
