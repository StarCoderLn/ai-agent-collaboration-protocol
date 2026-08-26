import { describe, expect, it } from "vitest";

import { formatMinorAmount, parseEthToWei } from "./money";

describe("native ETH money boundary", () => {
	it("converts decimal ETH to wei without Number precision loss", () => {
		expect(parseEthToWei("0.0128")).toBe("12800000000000000");
		expect(parseEthToWei("1.000000000000000001")).toBe("1000000000000000001");
	});

	it("rejects zero, negative and values with more than 18 decimals", () => {
		expect(parseEthToWei("0")).toBeNull();
		expect(parseEthToWei("-1")).toBeNull();
		expect(parseEthToWei("0.0000000000000000001")).toBeNull();
	});

	it("formats wei as an exact ETH amount", () => {
		expect(formatMinorAmount("12800000000000000", "ETH")).toBe("0.0128 ETH");
		expect(formatMinorAmount("1000000000000000001", "ETH")).toBe("1.000000000000000001 ETH");
	});
});
