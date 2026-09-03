import { createHash } from "node:crypto";
import type { ApiResponse } from "./http.js";

type StoredResponse = Readonly<{
  fingerprint: string;
  response: Promise<ApiResponse>;
}>;

export type IdempotentExecution =
  | Readonly<{ kind: "response"; response: ApiResponse; replayed: boolean }>
  | Readonly<{ kind: "conflict" }>;

/** AICP v1 要求幂等键恰好三段；额外冒号不能被静默截断后接受。 */
export function isValidIdempotencyKey(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

/**
 * 同一个键保存正在执行的 Promise，而不是只保存最终响应，因而并发重复请求也只会启动
 * 一次昂贵的 Agent 调用。5xx 与异常会释放记录，让平台能够使用原幂等键安全重试。
 */
export class MemoryIdempotencyRegistry {
  readonly #records = new Map<string, StoredResponse>();

  async execute(
    key: string,
    body: Uint8Array,
    operation: () => Promise<ApiResponse>,
  ): Promise<IdempotentExecution> {
    const fingerprint = createHash("sha256").update(body).digest("hex");
    const existing = this.#records.get(key);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
      const response = await existing.response;
      return { kind: "response", response, replayed: true };
    }

    const responsePromise = operation();
    this.#records.set(key, { fingerprint, response: responsePromise });
    try {
      const response = await responsePromise;
      if (response.status >= 500) this.#records.delete(key);
      return { kind: "response", response, replayed: false };
    } catch (error) {
      this.#records.delete(key);
      throw error;
    }
  }
}

/** 为命中幂等重放的响应增加可观察标记，同时保留原响应的其余字段。 */
export function markIdempotentReplay(response: ApiResponse): ApiResponse {
  return {
    ...response,
    headers: { ...response.headers, "x-idempotent-replay": "true" },
  };
}
