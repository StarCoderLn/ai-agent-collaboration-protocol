import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { AgentConnectionTestError } from "../agents/agent-connection-test";
import { HttpAgentConnectionProbe } from "./agent-connection-probe";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).filter((server) => server.listening).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

async function startAgentServer(options: {
  statusCode?: number;
  body?: string;
  expectedAuthorization?: string;
} = {}): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url !== "/healthz") {
      response.writeHead(404).end();
      return;
    }
    if (options.expectedAuthorization !== undefined && request.headers.authorization !== options.expectedAuthorization) {
      response.writeHead(401).end();
      return;
    }
    response.writeHead(options.statusCode ?? 200, { "content-type": "application/json" });
    response.end(options.body ?? JSON.stringify({ status: "ok" }));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/run`;
}

describe("HttpAgentConnectionProbe", () => {
  it("本地模式允许公开 HTTP Agent，并固定探测同域 /healthz", async () => {
    const endpoint = await startAgentServer();

    const result = await new HttpAgentConnectionProbe(true).probe({ serviceEndpoint: endpoint });

    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("有访问密钥时使用标准 Bearer 认证", async () => {
    const endpoint = await startAgentServer({ expectedAuthorization: "Bearer provider-token" });

    await expect(new HttpAgentConnectionProbe(true).probe({
      serviceEndpoint: endpoint,
      credentialSecret: "provider-token",
    })).resolves.toEqual({ latencyMs: expect.any(Number) });
  });

  it("把 401 响应转换为可读的访问密钥错误", async () => {
    const endpoint = await startAgentServer({ expectedAuthorization: "Bearer correct-token" });

    await expect(new HttpAgentConnectionProbe(true).probe({
      serviceEndpoint: endpoint,
      credentialSecret: "wrong-token",
    })).rejects.toMatchObject({ code: "AGENT_AUTH_FAILED", retryable: false });
  });

  it("拒绝不符合健康检查契约的 JSON", async () => {
    const endpoint = await startAgentServer({ body: JSON.stringify({ healthy: true }) });

    await expect(new HttpAgentConnectionProbe(true).probe({ serviceEndpoint: endpoint }))
      .rejects.toMatchObject({ code: "AGENT_HEALTH_INVALID" });
  });

  it("正式模式拒绝 HTTP 与私网目标", async () => {
    const probe = new HttpAgentConnectionProbe(false);

    await expect(probe.probe({ serviceEndpoint: "http://agent.example.com/run" }))
      .rejects.toMatchObject({ code: "AGENT_ENDPOINT_HTTPS_REQUIRED" });
    await expect(probe.probe({ serviceEndpoint: "https://127.0.0.1/run" }))
      .rejects.toMatchObject({ code: "AGENT_ENDPOINT_PRIVATE" });
  });

  it("错误对象保留面向 API 的稳定字段", () => {
    const error = new AgentConnectionTestError(422, "TEST", "message", false);

    expect(error).toMatchObject({ statusCode: 422, code: "TEST", retryable: false });
  });
});
