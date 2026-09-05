import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileArtifactStore } from "../src/artifact-store.js";
import { createQuickAgentServer } from "../src/quick-server.js";

const servers: Array<ReturnType<typeof createQuickAgentServer>> = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("快速接入 HTTP 运行时", () => {
	it("对相同幂等键和相同输入只执行一次并重放结果", async () => {
		const fixture = await startFixture();
		const body = validBody("生成一张营销图");

		const first = await run(fixture.baseUrl, "same-key-123", body);
		const replay = await run(fixture.baseUrl, "same-key-123", body);

		expect(first.status).toBe(200);
		expect(replay.headers.get("x-idempotent-replay")).toBe("true");
		expect(fixture.execute).toHaveBeenCalledTimes(1);
	});

	it("并发请求复用幂等键但输入不同会立即拒绝冲突", async () => {
		let releaseExecution: (() => void) | undefined;
		const executionGate = new Promise<void>((resolve) => {
			releaseExecution = resolve;
		});
		const fixture = await startFixture(async () => {
			await executionGate;
			return completedResponse;
		});

		const firstPromise = run(fixture.baseUrl, "conflict-key-123", validBody("第一张图"));
		await vi.waitFor(() => expect(fixture.execute).toHaveBeenCalledTimes(1));
		const conflict = await run(fixture.baseUrl, "conflict-key-123", validBody("第二张图"));
		releaseExecution?.();
		await firstPromise;

		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({ error_code: "IDEMPOTENCY_CONFLICT", retryable: false });
		expect(fixture.execute).toHaveBeenCalledTimes(1);
	});

	it("访问密钥错误时不会执行 Agent", async () => {
		const fixture = await startFixture();
		const response = await fetch(`${fixture.baseUrl}/run`, {
			method: "POST",
			headers: {
				Authorization: "Bearer wrong-key",
				"Content-Type": "application/json",
				"Idempotency-Key": "auth-test-123",
			},
			body: validBody("不会执行"),
		});

		expect(response.status).toBe(401);
		expect(fixture.execute).not.toHaveBeenCalled();
	});
});

const completedResponse = {
	status: "completed" as const,
	artifacts: [{ type: "document" as const, summary: "测试结果", content: "# 完成" }],
};

async function startFixture(implementation = async () => completedResponse) {
	const directory = await mkdtemp(join(tmpdir(), "aicp-quick-agent-"));
	const execute = vi.fn(implementation);
	const server = createQuickAgentServer({
		name: "测试 Agent",
		apiKey: "valid-test-key",
		artifactStore: new FileArtifactStore(join(directory, "artifacts"), "http://127.0.0.1"),
		responseCacheDirectory: join(directory, "cache"),
		execute,
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address() as AddressInfo;
	return { baseUrl: `http://127.0.0.1:${address.port}`, execute };
}

function validBody(title: string): string {
	return JSON.stringify({ task: { title }, upstreamArtifacts: [] });
}

async function run(baseUrl: string, key: string, body: string): Promise<Response> {
	return fetch(`${baseUrl}/run`, {
		method: "POST",
		headers: {
			Authorization: "Bearer valid-test-key",
			"Content-Type": "application/json",
			"Idempotency-Key": key,
		},
		body,
	});
}
