export function formatMoney(amountMinor: number, currency = "USDC", locale = "zh-CN") {
	return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amountMinor / 100)} ${currency}`;
}

export function formatDate(value: string, locale = "zh-CN") {
	return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function shortId(value: string) {
	return value.length <= 16 ? value : `${value.slice(0, 8)}…${value.slice(-6)}`;
}
