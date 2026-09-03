import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type ApiRequest = Readonly<{
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
  signal?: AbortSignal;
}>;

export type ApiResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

export type AgentHttpHandler = (request: ApiRequest) => Promise<ApiResponse>;

export type NodeHttpServerOptions = Readonly<{
  maxBodyBytes?: number;
  bodyTooLargeMessage?: string;
  internalErrorMessage?: string;
}>;

/**
 * 把 Node 原生 HTTP 细节收拢为与框架无关的 ApiRequest。协议验签必须使用这里保留的原始
 * body；调用方不能先 JSON.parse 再重新编码，否则合法签名会因为字节变化而失效。
 */
export function createAgentHttpServer(
  handler: AgentHttpHandler,
  options: NodeHttpServerOptions = {},
): Server {
  const maxBodyBytes = options.maxBodyBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new Error("maxBodyBytes must be a positive safe integer");
  }
  return createServer(async (request, response) => {
    try {
      const apiRequest = await toApiRequest(request, maxBodyBytes);
      writeApiResponse(response, await handler(apiRequest));
    } catch (error) {
      const tooLarge = error instanceof BodyTooLargeError;
      writeApiResponse(
        response,
        jsonResponse(tooLarge ? 413 : 500, {
          error: tooLarge
            ? (options.bodyTooLargeMessage ?? "request body too large")
            : (options.internalErrorMessage ?? "internal server error"),
        }),
      );
    }
  });
}

/** 生成带统一安全响应头的 JSON，避免每个 Agent 重复维护这些传输规则。 */
export function jsonResponse(status: number, value: unknown): ApiResponse {
  return {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
    body: Buffer.from(JSON.stringify(value)),
  };
}

/** 测试使用端口 0 时返回操作系统实际分配的监听地址。 */
export function listeningAddress(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server does not have a TCP listening address");
  }
  const tcpAddress = address as AddressInfo;
  return `${tcpAddress.address}:${tcpAddress.port}`;
}

async function toApiRequest(request: IncomingMessage, maxBodyBytes: number): Promise<ApiRequest> {
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(",") : value;
  }
  return {
    method: request.method ?? "",
    path: new URL(request.url ?? "/", "http://agent.local").pathname,
    headers,
    body: await readBody(request, maxBodyBytes),
    signal: abortController.signal,
  };
}

async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > maxBodyBytes) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeApiResponse(response: ServerResponse, apiResponse: ApiResponse): void {
  response.writeHead(apiResponse.status, apiResponse.headers);
  response.end(apiResponse.body);
}

class BodyTooLargeError extends Error {}
