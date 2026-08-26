/**
 * 产品界面只让发布者选择“交付日期”，精确时分属于平台调度细节。API 继续接收 ISO
 * 时间戳，因此统一在这个边界把本地日期转换成当天最后一毫秒，避免不同表单各自拼接
 * `23:59` 并产生时区或夏令时差异。
 */
export function localDateToDeadlineIso(value: string): string {
	const parsed = parseLocalDate(value);
	if (parsed === null) throw new Error("INVALID_DEADLINE");
	const endOfDay = new Date(
		parsed.getFullYear(),
		parsed.getMonth(),
		parsed.getDate(),
		23,
		59,
		59,
		999,
	);
	return endOfDay.toISOString();
}

/** 把服务端 ISO 截止时间还原为当前用户所处时区的日历日期。 */
export function deadlineIsoToLocalDate(value: string | null): string {
	if (value === null) return "";
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) return "";
	return formatLocalDateValue(date);
}

/**
 * 严格解析浏览器无时区的 YYYY-MM-DD 值。Date 自带的字符串解析会把这种格式当作
 * UTC，西半球用户可能因此看到前一天，所以这里按本地年月日显式构造。
 */
export function parseLocalDate(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
	if (match === null) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const date = new Date(year, month - 1, day);
	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day
	) {
		return null;
	}
	return date;
}

export function formatLocalDateValue(date: Date): string {
	const year = date.getFullYear().toString().padStart(4, "0");
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");
	return `${year}-${month}-${day}`;
}
