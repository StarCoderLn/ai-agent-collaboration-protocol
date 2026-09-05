import { describe, expect, it } from "vitest";

import { matchingTagLabel } from "./matching-tag-label";

describe("matchingTagLabel", () => {
	it("把协议内部的 research 标签显示为当前语言的可读名称", () => {
		expect(matchingTagLabel("research", "zh-CN")).toBe("学术研究");
		expect(matchingTagLabel("research", "en")).toBe("Academic research");
	});

	it("保留平台未知的提供者自定义标签", () => {
		expect(matchingTagLabel("openalex", "zh-CN")).toBe("openalex");
	});
});
