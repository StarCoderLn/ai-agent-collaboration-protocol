import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentHttpServer,
  jsonResponse,
  listeningAddress,
} from "../src/http.js";

const servers: ReturnType<typeof createAgentHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

describe("createAgentHttpServer", () => {
  it("保留原始请求体并归一化请求头", async () => {
    let observedBody = "";
    const server = createAgentHttpServer(async (request) => {
      observedBody = Buffer.from(request.body).toString("utf8");
      return jsonResponse(200, { header: request.headers["x-test"] });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const response = await fetch(`http://${listeningAddress(server)}/agent`, {
      method: "POST",
      headers: { "X-Test": "value", "Content-Type": "application/json" },
      body: '{ "order": 1 }',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ header: "value" });
    expect(observedBody).toBe('{ "order": 1 }');
  });

  it("在缓存完整正文前拒绝超过上限的请求", async () => {
    const server = createAgentHttpServer(
      async () => jsonResponse(200, { unreachable: true }),
      { maxBodyBytes: 4, bodyTooLargeMessage: "body too large" },
    );
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const response = await fetch(`http://${listeningAddress(server)}/agent`, {
      method: "POST",
      body: "12345",
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "body too large" });
  });
});
