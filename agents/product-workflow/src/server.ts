import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ApiRequest, ApiResponse, WorkflowApi } from "./api.js";

const MAX_BODY_BYTES = 4 << 20;

export function createWorkflowServer(api: WorkflowApi) {
  return createServer(async (request, response) => {
    try {
      const apiRequest = await toApiRequest(request);
      writeResponse(response, await api.handle(apiRequest));
    } catch (error) {
      const status = error instanceof BodyTooLargeError ? 413 : 500;
      writeResponse(response, {
        status,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: Buffer.from(JSON.stringify({ error: status === 413 ? "body too large" : "internal error" })),
      });
    }
  });
}

async function toApiRequest(request: IncomingMessage): Promise<ApiRequest> {
  const abortController = new AbortController();
  request.once("aborted", () => abortController.abort());
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name] = Array.isArray(value) ? value.join(",") : value;
  }
  return {
    method: request.method ?? "",
    path: new URL(request.url ?? "/", "http://localhost").pathname,
    headers,
    body: await readBody(request),
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
      throw new BodyTooLargeError();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeResponse(response: ServerResponse, apiResponse: ApiResponse): void {
  response.writeHead(apiResponse.status, apiResponse.headers);
  response.end(apiResponse.body);
}

class BodyTooLargeError extends Error {}
