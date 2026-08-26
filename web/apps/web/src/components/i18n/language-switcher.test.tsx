import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import LanguageSwitcher from "./language-switcher";
import { LocaleProvider, useLocale } from "./locale-provider";

function Probe() {
	const { locale, t } = useLocale();
	return (
		<output>
			{locale}:{t("发布任务")}
		</output>
	);
}

afterEach(cleanup);

describe("LanguageSwitcher", () => {
	it("keeps language choices in a compact menu", () => {
		render(
			<LocaleProvider initialLocale="en">
				<LanguageSwitcher />
				<Probe />
			</LocaleProvider>,
		);

		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Change language" }));

		expect(screen.getByRole("menu")).toHaveClass("gap-1");
		expect(
			screen.getByRole("menuitemradio", { name: "English" }),
		).toHaveAttribute("aria-checked", "true");
		expect(
			screen.getByRole("menuitemradio", { name: "简体中文" }),
		).toHaveAttribute("aria-checked", "false");
	});

	it("switches immediately, persists the preference and closes the menu", () => {
		render(
			<LocaleProvider initialLocale="en">
				<LanguageSwitcher />
				<Probe />
			</LocaleProvider>,
		);

		expect(screen.getByText("en:Post a Task")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Change language" }));
		fireEvent.click(screen.getByRole("menuitemradio", { name: "简体中文" }));

		expect(screen.getByText("zh-CN:发布任务")).toBeInTheDocument();
		expect(document.documentElement.lang).toBe("zh-CN");
		expect(document.cookie).toContain("aicp_locale=zh-CN");
		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
	});

	it("closes the menu with Escape", () => {
		render(
			<LocaleProvider initialLocale="en">
				<LanguageSwitcher />
			</LocaleProvider>,
		);

		const trigger = screen.getByRole("button", { name: "Change language" });
		fireEvent.click(trigger);
		fireEvent.keyDown(document, { key: "Escape" });

		expect(screen.queryByRole("menu")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});
});
