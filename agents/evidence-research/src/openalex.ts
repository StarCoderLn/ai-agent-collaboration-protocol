import { z } from "zod";
import { EvidenceSourceSchema, type EvidenceSource } from "./domain.js";

// 只声明本 Agent 实际消费的 OpenAlex 字段。passthrough 允许上游增加无关字段而不破坏兼容性，
// 但所有已消费字段仍必须满足这里的运行时类型约束。
const OpenAlexWorkSchema = z
  .object({
    id: z.string(),
    title: z.string().nullable(),
    doi: z.string().nullable(),
    publication_year: z.number().int().nullable(),
    authorships: z.array(
      z.object({
        author: z.object({ display_name: z.string() }),
      }),
    ),
    primary_location: z
      .object({ landing_page_url: z.string().nullable() })
      .nullable(),
    abstract_inverted_index: z.record(z.string(), z.array(z.number().int())).nullable(),
  })
  .passthrough();

const OpenAlexResponseSchema = z.object({
  results: z.array(OpenAlexWorkSchema),
});

export type OpenAlexSearchInput = {
  query: string;
  limit: number;
  yearFrom?: number;
  yearTo?: number;
};

export interface ScholarlySearch {
  /** 检索并返回已标准化的证据；实现必须把取消信号传递给下游网络请求。 */
  search(input: OpenAlexSearchInput, signal?: AbortSignal): Promise<EvidenceSource[]>;
}

/** OpenAlex REST API 适配器，隐藏查询参数、超时和上游数据形状。 */
export class OpenAlexClient implements ScholarlySearch {
  readonly #baseUrl: URL;
  readonly #fetch: typeof fetch;

  constructor(options: { baseUrl?: URL; fetch?: typeof fetch } = {}) {
    // baseUrl/fetch 可注入，测试无需访问公网，也不需要破坏类的封装。
    this.#baseUrl = options.baseUrl ?? new URL("https://api.openalex.org/works");
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async search(input: OpenAlexSearchInput, signal?: AbortSignal): Promise<EvidenceSource[]> {
    const url = new URL(this.#baseUrl);
    url.searchParams.set("search", input.query);
    url.searchParams.set("per-page", String(input.limit));
    url.searchParams.set(
      "select",
      // 显式 select 减少网络体积，也让上游字段变化对本模块的影响更小。
      "id,title,doi,publication_year,authorships,primary_location,abstract_inverted_index",
    );

    const filters: string[] = [];
    if (input.yearFrom !== undefined) {
      filters.push(`from_publication_date:${input.yearFrom}-01-01`);
    }
    if (input.yearTo !== undefined) {
      filters.push(`to_publication_date:${input.yearTo}-12-31`);
    }
    if (filters.length > 0) {
      url.searchParams.set("filter", filters.join(","));
    }

    const timeoutSignal = AbortSignal.timeout(10_000);
    // 调用方取消和本适配器的 10 秒上限任一触发，都会终止 fetch。
    const requestSignal = signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    const response = await this.#fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "aicp-evidence-research-agent/0.1" },
      signal: requestSignal,
    });
    if (!response.ok) {
      throw new Error(`OpenAlex request failed with status ${response.status}`);
    }

    const payload = OpenAlexResponseSchema.parse(await response.json());
    return payload.results.flatMap((work): EvidenceSource[] => {
      // 没有标题的记录无法形成可读引用，直接丢弃而不是伪造占位标题。
      if (work.title === null) {
        return [];
      }
      return [
        EvidenceSourceSchema.parse({
          id: work.id,
          title: work.title,
          authors: work.authorships.map((authorship) => authorship.author.display_name),
          publicationYear: work.publication_year,
          doi: work.doi,
          // 优先提供论文落地页，其次 DOI，最后保留 OpenAlex 记录作为可追溯链接。
          url: work.primary_location?.landing_page_url ?? work.doi ?? work.id,
          abstract: reconstructAbstract(work.abstract_inverted_index),
        }),
      ];
    });
  }
}

export function reconstructAbstract(
  invertedIndex: Record<string, number[]> | null,
): string {
  // OpenAlex 为节省空间返回“单词 -> 出现位置”，这里恢复成人类/模型可读的顺序文本。
  if (invertedIndex === null) {
    return "";
  }

  const positionedWords: Array<{ position: number; word: string }> = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of positions) {
      positionedWords.push({ position, word });
    }
  }
  positionedWords.sort((left, right) => left.position - right.position);
  return positionedWords.map(({ word }) => word).join(" ");
}
