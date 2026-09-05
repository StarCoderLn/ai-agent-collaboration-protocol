import type { QueryExecutor } from "../db/pool";

export type MatchingTagTaxonomy = Readonly<{
  canonicalByAlias: ReadonlyMap<string, string>;
  forbiddenTags: ReadonlySet<string>;
}>;

type TagTaxonomyRow = Readonly<{
  canonical_name: string;
  synonyms: readonly string[];
  forbidden: boolean;
}>;

/**
 * 从数据库构建任务与 Agent 共用的标签归一化策略。
 *
 * 数据库中的 canonical_name 是匹配协议使用的稳定值，中文、英文和历史叫法只作为
 * alias 指向它。所有写入入口复用本函数，避免任务把“research”写成标准值、Agent
 * 却把“学术研究”原样保存，最终让语义相同的双方得到零匹配分。
 */
export async function loadMatchingTagTaxonomy(
  db: QueryExecutor,
): Promise<MatchingTagTaxonomy> {
  const result = await db.query<TagTaxonomyRow>(
    "SELECT canonical_name,synonyms,forbidden FROM tags",
    [],
  );
  const canonicalByAlias = new Map<string, string>();
  const forbiddenTags = new Set<string>();
  for (const tag of result.rows) {
    const canonical = normalizeTaxonomyKey(tag.canonical_name);
    canonicalByAlias.set(canonical, canonical);
    for (const alias of tag.synonyms) {
      canonicalByAlias.set(normalizeTaxonomyKey(alias), canonical);
    }
    if (tag.forbidden) forbiddenTags.add(canonical);
  }
  return { canonicalByAlias, forbiddenTags };
}

/** 别名键与自由标签采用相同的大小写和空白规则，不能维护第二套匹配语义。 */
function normalizeTaxonomyKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}
