/**
 * 浏览器端即时反馈规则，数值必须与 Business API 的可信边界保持一致。服务端仍会
 * 重新校验，前端版本只用于让用户在输入时立刻知道原因，而不是承担安全职责。
 */
export const MAX_MATCHING_TAG_COUNT = 10;
export const MAX_MATCHING_TAG_LENGTH = 32;

/** 自定义标签与服务端使用相同的小写、空白压缩规则，页面展示的就是最终匹配值。 */
export function normalizeMatchingTag(rawTag: string): string {
	return rawTag.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

export function isMatchingTagSyntaxValid(tag: string): boolean {
	const containsUnsafeCharacter = [...tag].some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return (
			character === "," ||
			character === "，" ||
			codePoint < 32 ||
			codePoint === 127
		);
	});
	return /[\p{L}\p{N}]/u.test(tag) && !containsUnsafeCharacter;
}
