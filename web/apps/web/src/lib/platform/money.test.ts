import { describe, expect, it } from "vitest";

import { formatMinorAmount, parseUsdcToMinor } from "./money";

describe("USDC money boundary", () => {
	it("converts decimal USDC to six-decimal minor units without Number precision loss", () => {
		expect(parseUsdcToMinor("12.80")).toBe("12800000");
		expect(parseUsdcToMinor("100000.000001")).toBe("100000000001");
	});

	it("rejects zero, negative and values with more than six decimals", () => {
		expect(parseUsdcToMinor("0")).toBeNull();
		expect(parseUsdcToMinor("-1")).toBeNull();
		expect(parseUsdcToMinor("0.0000001")).toBeNull();
	});

	it("formats USDC minor units exactly and never guesses another currency precision", () => {
		expect(formatMinorAmount("12800000", "USDC")).toBe("12.8 USDC");
		expect(formatMinorAmount("100000000001", "USDC")).toBe(
			"100,000.000001 USDC",
		);
		expect(formatMinorAmount("42", "UNKNOWN")).toBe("42 UNKNOWN");
	});
});
