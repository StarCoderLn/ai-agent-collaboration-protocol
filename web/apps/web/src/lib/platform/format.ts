export function formatMoney(
	amountMinor: number,
	currency = "USDC",
	locale = "zh-CN",
) {
	return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100)} ${currency}`;
}

export function formatDate(value: string, locale = "zh-CN") {
	return new Intl.DateTimeFormat(locale, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(value));
}

/**
 * 市场卡片横向空间有限，只展示用户决策真正需要的自然日期。固定使用年、月、日顺序和
 * 两位数字，既避免中文长日期在三列布局中被截断，也避免不同语言下月日顺序产生歧义。
 * 日期仍按浏览器本地时区解释，与详情页现有日期展示保持一致。
 */
export function formatCompactDate(value: string) {
	const date = new Date(value);
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${year}.${month}.${day}`;
}

export function shortId(value: string) {
	return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}
