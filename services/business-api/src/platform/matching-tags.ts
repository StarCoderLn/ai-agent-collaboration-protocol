/**
 * 任务与 Agent 共用的匹配标签策略。
 *
 * 标签协议仍然是简单的 `string[]`，但所有写入入口必须在这里完成相同的规范化与
 * 边界校验。平台内置标签可以通过 canonicalByAlias 把同义词收敛到规范名称；不在
 * 词表中的标签则作为用户自定义标签保留。匹配引擎仍按规范化后的精确交集计算，
 * 不会把两个含义不同但文字相似的自由标签擅自合并。
 */
export const MAX_MATCHING_TAG_COUNT = 10;
export const MAX_MATCHING_TAG_LENGTH = 32;

export type MatchingTagIssue = Readonly<{
  code: "TAG_COUNT_EXCEEDED" | "TAG_TOO_LONG" | "TAG_INVALID" | "FORBIDDEN_TAG";
  message: string;
}>;

/**
 * 小写、压缩连续空白、应用平台同义词并去重排序。稳定排序让审计快照、幂等请求和
 * 匹配证据不会因为用户点击标签的先后顺序不同而产生无意义差异。
 */
export function normalizeMatchingTags(
  tags: readonly string[],
  canonicalByAlias: ReadonlyMap<string, string> = new Map(),
): readonly string[] {
  const normalized = new Set<string>();
  for (const rawTag of tags) {
    const clean = normalizeMatchingTag(rawTag);
    if (clean.length === 0) continue;
    normalized.add(canonicalByAlias.get(clean) ?? clean);
  }
  return [...normalized].sort();
}

/**
 * 从用户自然语言中识别平台词表已有的能力。这里只做可复现的词表召回，不伪装成
 * 大模型语义理解：中文和较长短语允许直接包含，短英文词要求词边界，避免把 `go`
 * 从 `google` 中误识别出来。更复杂的语义召回可以在同一接口后替换而不影响调用方。
 */
export function inferMatchingTagsFromText(
  text: string,
  canonicalByAlias: ReadonlyMap<string, string>,
): readonly string[] {
  const normalizedText = text.toLocaleLowerCase().replace(/\s+/gu, " ");
  const inferred = new Set<string>();
  for (const [alias, canonical] of canonicalByAlias) {
    if (alias.length === 0) continue;
    const containsCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(alias);
    const matched = containsCjk || alias.length >= 4
      ? normalizedText.includes(alias)
      : new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(alias)}([^\\p{L}\\p{N}]|$)`, "u").test(normalizedText);
    if (matched) inferred.add(canonical);
    if (inferred.size >= MAX_MATCHING_TAG_COUNT) break;
  }
  return [...inferred].sort();
}

/** 单个标签的展示值和匹配值必须一致，避免只在提交时突然改变用户输入。 */
export function normalizeMatchingTag(rawTag: string): string {
  return rawTag.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

/**
 * 自定义标签允许中英文、技术符号和空格，只拒绝无法用于可靠分隔/展示的控制字符、
 * 中英文逗号以及完全不含字母或数字的内容。禁用词来自数据库配置，由可信服务边界
 * 传入，不能依赖前端提示承担安全职责。
 */
export function validateMatchingTags(
  tags: readonly string[],
  forbiddenTags: ReadonlySet<string>,
): readonly MatchingTagIssue[] {
  const normalized = normalizeMatchingTags(tags);
  const issues: MatchingTagIssue[] = [];
  if (normalized.length > MAX_MATCHING_TAG_COUNT) {
    issues.push({
      code: "TAG_COUNT_EXCEEDED",
      message: `最多选择 ${MAX_MATCHING_TAG_COUNT} 个标签`,
    });
  }

  for (const tag of normalized) {
    if ([...tag].length > MAX_MATCHING_TAG_LENGTH) {
      issues.push({
        code: "TAG_TOO_LONG",
        message: `标签“${tag}”最多 ${MAX_MATCHING_TAG_LENGTH} 个字符`,
      });
    } else if (!isMatchingTagSyntaxValid(tag)) {
      issues.push({
        code: "TAG_INVALID",
        message: `标签“${tag}”包含不支持的字符`,
      });
    }
    if (forbiddenTags.has(tag)) {
      issues.push({ code: "FORBIDDEN_TAG", message: `标签“${tag}”已被平台禁用` });
    }
  }
  return issues;
}

export function isMatchingTagSyntaxValid(tag: string): boolean {
  const containsUnsafeCharacter = [...tag].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === "," || character === "，" || codePoint < 32 || codePoint === 127;
  });
  return /[\p{L}\p{N}]/u.test(tag) && !containsUnsafeCharacter;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
