"use client";

import { createContext, type ReactNode, useContext, useMemo, useState } from "react";

import { type AppLocale, LOCALE_COOKIE } from "@/lib/i18n/locale";
import { translate, type MessageId, type MessageValues } from "@/lib/i18n/messages";

type LocaleContextValue = Readonly<{
	locale: AppLocale;
	setLocale(locale: AppLocale): void;
	t(id: MessageId, values?: MessageValues): string;
}>;

// 部分独立组件测试早于应用级 Provider，因而使用可读的中文回退值；真实应用始终传入在
// 请求边界解析出的语言设置，不受该测试回退影响。
const LocaleContext = createContext<LocaleContextValue>({
	locale: "zh-CN",
	setLocale() {},
	t: (id, values) => translate("zh-CN", id, values),
});

export function LocaleProvider({ initialLocale, children }: { initialLocale: AppLocale; children: ReactNode }) {
	const [locale, setLocaleState] = useState<AppLocale>(initialLocale);
	const value = useMemo<LocaleContextValue>(() => ({
		locale,
		setLocale(nextLocale) {
			document.cookie = `${LOCALE_COOKIE}=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
			document.documentElement.lang = nextLocale;
			setLocaleState(nextLocale);
		},
		t: (id, values) => translate(locale, id, values),
	}), [locale]);

	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
	return useContext(LocaleContext);
}
