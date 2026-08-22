import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { postLocalAgent } from "./server-client";

let server: Server | undefined;

afterEach(async () => {
	if (server !== undefined) {
		await new Promise<void>((resolve, reject) => {
			server?.close((error) =>
				error === undefined ? resolve() : reject(error),
			);
		});
		server = undefined;
	}
});

describe("postLocalAgent", () => {
	it("waits for and parses a bounded JSON response", async () => {
		server = createServer((request, response) => {
			expect(request.headers["x-protocol-version"]).toBe("1.0");
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ callType: "sandbox" }));
		});
		const endpoint = await listen(server);

		await expect(
			postLocalAgent(
				endpoint,
				{ "X-Protocol-Version": "1.0" },
				Buffer.from("{}"),
				1_000,
			),
		).resolves.toEqual({ status: 200, body: { callType: "sandbox" } });
	});

	it("uses the explicit task timeout when the Agent never sends headers", async () => {
		server = createServer(() => {
			// 刻意不发送响应；客户端必须由显式 timeoutMs 终止，而不是永久等待。
		});
		const endpoint = await listen(server);

		await expect(
			postLocalAgent(endpoint, {}, Buffer.from("{}"), 10),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

async function listen(target: Server): Promise<URL> {
	await new Promise<void>((resolve, reject) => {
		target.once("error", reject);
		target.listen(0, "127.0.0.1", resolve);
	});
	const address = target.address();
	if (address === null || typeof address === "string") {
		throw new Error("test HTTP server did not expose a TCP port");
	}
	return new URL(`http://127.0.0.1:${address.port}/v1/research`);
}
