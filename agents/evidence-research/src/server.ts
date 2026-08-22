import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { ResearchApi, type ApiRequest } from "./api.js";

const MAX_BODY_BYTES = 1 << 20;

/**
 * Node HTTP 到 ResearchApi 的传输适配器。
 * 这里不包含验签或研究业务规则，只负责流式读 body、传递断连信号和写回响应。
 */
export function createResearchServer(api: ResearchApi) {
  return createServer(async (request, response) => {
    try {
      const apiRequest = await toApiRequest(request);
      const apiResponse = await api.handle(apiRequest);
      writeApiResponse(response, apiResponse);
    } catch (error) {
      // 对外只返回稳定、无敏感细节的错误；具体异常不会连同栈信息泄露给客户端。
      const status = error instanceof BodyTooLargeError ? 413 : 500;
      writeApiResponse(response, {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: Buffer.from(
          JSON.stringify({ error: status === 413 ? "request body exceeds 1 MiB limit" : "internal server error" }),
        ),
      });
    }
  });
}

async function toApiRequest(request: IncomingMessage): Promise<ApiRequest> {
  const abortController = new AbortController();
  // 客户端在上传或等待期间断开时，向 OpenAlex 和 Mastra 传播取消信号。
  request.once("aborted", () => abortController.abort());
  const body = await readBody(request);
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    // Node 已将 header 名转成小写；重复值合并后交给协议层统一读取。
    headers[name] = Array.isArray(value) ? value.join(",") : value;
  }
  return {
    method: request.method ?? "",
    path: new URL(request.url ?? "/", "http://localhost").pathname,
    headers,
    body,
    signal: abortController.signal,
  };
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      // 在继续缓存剩余数据前终止，避免超大请求耗尽进程内存。API 层另有限制，用于保护
      // 绕过本 HTTP 适配器、直接调用 ResearchApi 的其他入口。
      throw new BodyTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeApiResponse(
  response: ServerResponse,
  apiResponse: { status: number; headers: Record<string, string>; body: Uint8Array },
): void {
  response.writeHead(apiResponse.status, apiResponse.headers);
  response.end(apiResponse.body);
}

class BodyTooLargeError extends Error {}

export function listeningAddress(server: ReturnType<typeof createResearchServer>): string {
  // 测试使用端口 0 时，通过该辅助函数取得操作系统实际分配的 TCP 地址。
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server does not have a TCP listening address");
  }
  const tcpAddress = address as AddressInfo;
  return `${tcpAddress.address}:${tcpAddress.port}`;
}
