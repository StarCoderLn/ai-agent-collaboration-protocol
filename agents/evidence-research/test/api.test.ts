import { describe, expect, it } from "vitest";
import { ResearchApi, type ApiRequest } from "../src/api.js";
import type { ResearchReport, ResearchTaskInput } from "../src/domain.js";
import { signRequest } from "../src/protocol.js";
import type { ResearchExecutionContext, ResearchExecutor } from "../src/research.js";

const now = new Date("2026-08-22T00:00:00Z");
const secret = "api-test-signing-secret";

class FakeExecutor implements ResearchExecutor {
  calls = 0;

  async run(input: ResearchTaskInput): Promise<ResearchReport> {
    this.calls += 1;
    return {
      schemaVersion: "paper.report.v0.1",
      taskId: input.taskId,
      title: "Grounded report",
      executiveSummary: "Summary",
      sections: [
        { heading: "One", content: "Evidence", citationIds: ["source-1"] },
        { heading: "Two", content: "Conclusion", citationIds: ["source-1"] },
      ],
      sources: [
        {
          id: "source-1",
          title: "Source",
          authors: ["Author"],
          publicationYear: 2025,
          doi: null,
          url: "https://example.test/source-1",
        },
      ],
      limitations: [],
      generatedAt: now.toISOString(),
    };
  }
}

describe("ResearchApi", () => {
  it("executes a signed sandbox request and replays its idempotent result", async () => {
    const executor = new FakeExecutor();
    const api = new ResearchApi({ agentId: "paper-agent", secret, executor, now: () => now });
    const body = validBody();

    const first = await api.handle(signedRequest(body, "nonce-1", "research:task-1:client-1"));
    const replay = await api.handle(signedRequest(body, "nonce-2", "research:task-1:client-1"));

    expect(first.status).toBe(200);
    expect(JSON.parse(Buffer.from(first.body).toString("utf8"))).toMatchObject({
      agentId: "paper-agent",
      callType: "sandbox",
      result: { taskId: "task-1" },
    });
    expect(replay.headers["x-idempotent-replay"]).toBe("true");
    expect(Buffer.from(replay.body)).toEqual(Buffer.from(first.body));
    expect(executor.calls).toBe(1);
  });

  it("rejects a forged signature without executing research", async () => {
    const executor = new FakeExecutor();
    const api = new ResearchApi({ agentId: "paper-agent", secret, executor, now: () => now });
    const request = signedRequest(validBody(), "nonce-forged", "research:task-1:client-2");
    request.headers["x-signature"] = "0".repeat(64);

    const response = await api.handle(request);

    expect(response.status).toBe(401);
    expect(JSON.parse(Buffer.from(response.body).toString("utf8"))).toMatchObject({
      error_code: "AUTH_INVALID_SIGNATURE",
      retryable: false,
    });
    expect(executor.calls).toBe(0);
  });

  it("rejects reuse of an idempotency key with a different body", async () => {
    const executor = new FakeExecutor();
    const api = new ResearchApi({ agentId: "paper-agent", secret, executor, now: () => now });
    const key = "research:task-1:client-3";
    await api.handle(signedRequest(validBody(), "nonce-3", key));
    const changedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(validBody().toString("utf8")), topic: "A different topic" }),
    );

    const response = await api.handle(signedRequest(changedBody, "nonce-4", key));

    expect(response.status).toBe(409);
    expect(executor.calls).toBe(1);
  });

  it("cancels execution at the configured timeout and allows a later retry", async () => {
    const executor: ResearchExecutor = {
      run: async (_input: ResearchTaskInput, context?: ResearchExecutionContext) =>
        new Promise<ResearchReport>((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    };
    const api = new ResearchApi({
      agentId: "paper-agent",
      secret,
      executor,
      now: () => now,
      executionTimeoutMs: 5,
    });
    const body = validBody();

    const first = await api.handle(signedRequest(body, "nonce-timeout-1", "research:task-1:timeout"));
    const retry = await api.handle(signedRequest(body, "nonce-timeout-2", "research:task-1:timeout"));

    expect(first.status).toBe(502);
    expect(retry.status).toBe(502);
    expect(retry.headers["x-idempotent-replay"]).toBeUndefined();
  });
});

function validBody(): Buffer {
  return Buffer.from(
    JSON.stringify({
      schemaVersion: "paper.research.v0.1",
      taskId: "task-1",
      topic: "Agent protocol reliability",
      researchQuestion: "How can distributed agent protocols resist replay attacks?",
      language: "en",
      targetWords: 1_000,
      sourceCount: 5,
    }),
  );
}

function signedRequest(body: Buffer, nonce: string, idempotencyKey: string): ApiRequest & { headers: Record<string, string> } {
  const signedHeaders = signRequest(
    { method: "POST", path: "/v1/research", body, callType: "sandbox" },
    secret,
    { now, nonce },
  );
  return {
    method: "POST",
    path: "/v1/research",
    body,
    headers: {
      ...Object.fromEntries(
        Object.entries(signedHeaders).map(([name, value]) => [name.toLowerCase(), value]),
      ),
      "idempotency-key": idempotencyKey,
    },
  };
}
