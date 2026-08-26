export const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: AppLocale = "en";
export const LOCALE_COOKIE = "aicp_locale";

export function isAppLocale(value: unknown): value is AppLocale {
	return typeof value === "string" && SUPPORTED_LOCALES.includes(value as AppLocale);
}

/**
 * 用户显式保存的偏好始终优先。首次访问时，中文浏览器使用中文，其他浏览器使用面向
 * 国际用户的英文默认值。
 */
export function resolveAppLocale(saved: string | undefined, acceptLanguage = ""): AppLocale {
	if (isAppLocale(saved)) return saved;
	return /(^|,)\s*zh(?:-|;|,|$)/i.test(acceptLanguage) ? "zh-CN" : DEFAULT_LOCALE;
}
