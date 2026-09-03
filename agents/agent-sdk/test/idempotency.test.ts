import { describe, expect, it } from "vitest";
import {
  isValidIdempotencyKey,
  MemoryIdempotencyRegistry,
} from "../src/idempotency.js";
import { jsonResponse } from "../src/http.js";

describe("MemoryIdempotencyRegistry", () => {
  it("让并发重复请求共享一次执行并标记重放", async () => {
    const registry = new MemoryIdempotencyRegistry();
    let calls = 0;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = async () => {
      calls += 1;
      await blocked;
      return jsonResponse(202, { queued: true });
    };

    const first = registry.execute("dispatch:task:request", Buffer.from("{}"), operation);
    const second = registry.execute("dispatch:task:request", Buffer.from("{}"), operation);
    release?.();

    expect(await first).toMatchObject({ kind: "response", replayed: false });
    expect(await second).toMatchObject({ kind: "response", replayed: true });
    expect(calls).toBe(1);
  });

  it("拒绝同一个键对应不同请求体", async () => {
    const registry = new MemoryIdempotencyRegistry();
    await registry.execute("dispatch:task:request", Buffer.from("one"), async () =>
      jsonResponse(202, { queued: true }),
    );
    await expect(
      registry.execute("dispatch:task:request", Buffer.from("two"), async () =>
        jsonResponse(202, { queued: true }),
      ),
    ).resolves.toEqual({ kind: "conflict" });
  });

  it("只接受恰好三段的协议键", () => {
    expect(isValidIdempotencyKey("dispatch:task:request")).toBe(true);
    expect(isValidIdempotencyKey("assign:request")).toBe(false);
    expect(isValidIdempotencyKey("webhook:task:event:agent")).toBe(false);
  });
});
