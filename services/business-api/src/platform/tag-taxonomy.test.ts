import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "../db/pool.js";
import { loadMatchingTagTaxonomy } from "./tag-taxonomy.js";

describe("loadMatchingTagTaxonomy", () => {
  it("将 canonical 名称与中英文同义词收敛到同一个规范值", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        canonical_name: "research",
        synonyms: [" 学术研究 ", "Academic   Research", "论文写作"],
        forbidden: false,
      }],
      rowCount: 1,
    }));
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };

    const taxonomy = await loadMatchingTagTaxonomy(db);

    expect(taxonomy.canonicalByAlias.get("research")).toBe("research");
    expect(taxonomy.canonicalByAlias.get("学术研究")).toBe("research");
    expect(taxonomy.canonicalByAlias.get("academic research")).toBe("research");
    expect(taxonomy.canonicalByAlias.get("论文写作")).toBe("research");
    expect(taxonomy.forbiddenTags.size).toBe(0);
  });

  it("把禁用状态绑定到 canonical 值而不是某个同义词", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        canonical_name: "blocked-capability",
        synonyms: ["禁用能力"],
        forbidden: true,
      }],
      rowCount: 1,
    }));
    const db: QueryExecutor = { query: query as unknown as QueryExecutor["query"] };

    const taxonomy = await loadMatchingTagTaxonomy(db);

    expect(taxonomy.canonicalByAlias.get("禁用能力")).toBe("blocked-capability");
    expect(taxonomy.forbiddenTags).toEqual(new Set(["blocked-capability"]));
  });
});
