import { describe, expect, it } from "vitest";
import {
  ResearchTaskInputSchema,
  finalizeReport,
  type DraftResearchReport,
  type EvidenceSource,
} from "../src/domain.js";

const input = ResearchTaskInputSchema.parse({
  schemaVersion: "paper.research.v0.1",
  taskId: "task-1",
  topic: "Reliable agent protocols",
  researchQuestion: "How should agent protocols prevent replay attacks?",
});

const source: EvidenceSource = {
  id: "https://openalex.org/W1",
  title: "A protocol paper",
  authors: ["Ada Researcher"],
  publicationYear: 2025,
  doi: "https://doi.org/10.1/example",
  url: "https://doi.org/10.1/example",
  abstract: "A grounded abstract.",
};

const draft: DraftResearchReport = {
  title: "Replay-resistant protocols",
  executiveSummary: "A grounded summary.",
  sections: [
    { heading: "Threat", content: "Replay is a threat.", citationIds: [source.id] },
    { heading: "Mitigation", content: "Use nonces.", citationIds: [source.id] },
  ],
  limitations: [],
};

describe("finalizeReport", () => {
  it("publishes only sources actually collected by tools", () => {
    const report = finalizeReport(
      input,
      draft,
      new Map([[source.id, source]]),
      new Date("2026-08-22T00:00:00Z"),
    );
    expect(report.sources).toEqual([
      {
        id: source.id,
        title: source.title,
        authors: source.authors,
        publicationYear: source.publicationYear,
        doi: source.doi,
        url: source.url,
      },
    ]);
    expect(report.generatedAt).toBe("2026-08-22T00:00:00.000Z");
  });

  it("rejects model-invented citation identifiers", () => {
    const hallucinated: DraftResearchReport = {
      ...draft,
      sections: [
        { heading: "Threat", content: "Replay is a threat.", citationIds: ["invented"] },
        { heading: "Mitigation", content: "Use nonces.", citationIds: [source.id] },
      ],
    };
    expect(() => finalizeReport(input, hallucinated, new Map([[source.id, source]]), new Date())).toThrow(
      /not returned by tools/,
    );
  });
});
