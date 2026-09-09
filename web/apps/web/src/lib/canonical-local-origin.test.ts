import { describe, expect, it } from "vitest";

import { resolveCanonicalLocalOrigin } from "./canonical-local-origin";

describe("resolveCanonicalLocalOrigin", () => {
	it("识别与 SIWE 权威地址同端口的 localhost 别名", () => {
		expect(
			resolveCanonicalLocalOrigin(
				"localhost:3011",
				"http://127.0.0.1:3011",
			),
		).toBe("http://127.0.0.1:3011");
	});

	it("权威地址、生产域名和不同端口均保持原请求", () => {
		expect(
			resolveCanonicalLocalOrigin(
				"127.0.0.1:3011",
				"http://127.0.0.1:3011",
			),
		).toBeNull();
		expect(
			resolveCanonicalLocalOrigin(
				"aicp.example",
				"http://127.0.0.1:3011",
			),
		).toBeNull();
		expect(
			resolveCanonicalLocalOrigin(
				"localhost:3000",
				"http://127.0.0.1:3011",
			),
		).toBeNull();
	});
});
