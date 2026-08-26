"use client";

import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

type ThemeMode = "light" | "dark" | "system";
type ThemeContextValue = { theme: ThemeMode; setTheme: (theme: ThemeMode) => void };

const STORAGE_KEY = "aicp-theme";
const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * 主题边界只管理根节点的 `dark` class，不在 React 树内注入脚本。这样既保留
 * 浅色/深色/跟随系统，又避免第三方主题脚本在 React 19 客户端渲染时产生警告。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
	// 紫晶深色是品牌默认外观；已经主动选择过主题的用户仍以本地偏好为准。
	const [theme, setThemeState] = useState<ThemeMode>("dark");

	useEffect(() => {
		const saved = window.localStorage.getItem(STORAGE_KEY);
		// 品牌升级后不再让历史浅色偏好把整站恢复成白底；深色与跟随深色系统仍兼容。
		if (saved === "dark") setThemeState(saved);
	}, []);

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => document.documentElement.classList.toggle("dark", theme === "dark" || (theme === "system" && media.matches));
		apply();
		if (theme === "system") media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [theme]);

	const value = useMemo<ThemeContextValue>(() => ({
		theme,
		setTheme(nextTheme) {
			window.localStorage.setItem(STORAGE_KEY, nextTheme);
			setThemeState(nextTheme);
		},
	}), [theme]);

	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeMode() {
	const context = useContext(ThemeContext);
	if (context === null) throw new Error("useThemeMode 必须在 ThemeProvider 内调用");
	return context;
}
