import { describe, expect, it } from "vitest";

import { resolveAppLocale } from "./locale";
import { type MessageId, translate } from "./messages";

describe("application locale boundary", () => {
	it("uses a saved preference before browser language negotiation", () => {
		expect(resolveAppLocale("zh-CN", "en-US,en;q=0.9")).toBe("zh-CN");
		expect(resolveAppLocale("en", "zh-CN,zh;q=0.9")).toBe("en");
	});

	it("defaults international traffic to English and Chinese browsers to Chinese", () => {
		expect(resolveAppLocale(undefined, "fr-FR,fr;q=0.9,en;q=0.8")).toBe("en");
		expect(resolveAppLocale(undefined, "zh-TW,zh;q=0.9,en;q=0.8")).toBe(
			"zh-CN",
		);
	});

	it("keeps Chinese ids readable and interpolates both catalogs", () => {
		expect(
			translate("zh-CN", "打开钱包账户菜单 {address}", { address: "0x1234" }),
		).toBe("打开钱包账户菜单 0x1234");
		expect(
			translate("en", "打开钱包账户菜单 {address}", { address: "0x1234" }),
		).toBe("Open wallet account menu 0x1234");
	});

	it("英文目录遇到动态未知键时回退源文案，不让次要翻译缺失导致整页崩溃", () => {
		expect(translate("en", "未来新增状态" as MessageId)).toBe("未来新增状态");
	});
});
