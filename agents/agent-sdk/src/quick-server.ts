import { createHash, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
	QuickAgentResponseSchema,
	QuickRunRequestSchema,
	type QuickAgentExecutor,
	type QuickAgentResponse,
} from "./quick-contracts.js";
import type { FileArtifactStore } from "./artifact-store.js";

const MAX_REQUEST_BYTES = 1 << 20;

export type QuickAgentServerOptions = Readonly<{
	name: string;
	apiKey?: string;
	artifactStore: FileArtifactStore;
	responseCacheDirectory: string;
	executionTimeoutMs?: number;
	execute: QuickAgentExecutor;
}>;

/**
 * 三个示例 Agent 共用这一层 HTTP、认证和幂等实现，业务目录只保留各自生成逻辑。
 * 这是平台自建示例的内部复用模块，不是第三方快速接入的安装前提。
 */
export function createQuickAgentServer(options: QuickAgentServerOptions) {
	// 并发中的指纹必须和 Promise 一起保存。否则两个不同请求体复用同一幂等键时，
	// 后到请求会错误取得先到请求的产物，破坏“一个键只对应一个输入”的协议不变量。
	const pending = new Map<
		string,
		Readonly<{ fingerprint: string; responsePromise: Promise<QuickAgentResponse> }>
	>();
	return createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", "http://localhost");
			if (request.method === "GET" && url.pathname === "/healthz") {
				if (!authorized(request, options.apiKey)) return json(response, 401, errorBody("AUTH_FAILED", "访问密钥无效", false));
				return json(response, 200, { status: "ok", agent: options.name });
			}
			if (request.method === "GET" && url.pathname.startsWith("/artifacts/")) {
				const fileName = decodeURIComponent(url.pathname.slice("/artifacts/".length));
				const artifact = await options.artifactStore.read(fileName);
				if (artifact === null) return json(response, 404, errorBody("ARTIFACT_NOT_FOUND", "产物不存在", false));
				response.writeHead(200, {
					"Content-Type": artifact.mimeType,
					"Content-Length": String(artifact.content.byteLength),
					"Cache-Control": "private, max-age=3600",
					"X-Content-Type-Options": "nosniff",
				});
				response.end(artifact.content);
				return;
			}
			if (request.method !== "POST" || url.pathname !== "/run") {
				return json(response, 404, errorBody("ROUTE_NOT_FOUND", "接口不存在", false));
			}
			if (!authorized(request, options.apiKey)) return json(response, 401, errorBody("AUTH_FAILED", "访问密钥无效", false));
			const idempotencyKey = request.headers["idempotency-key"];
			if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 200) {
				return json(response, 422, errorBody("IDEMPOTENCY_KEY_INVALID", "缺少有效幂等键", false));
			}
			const body = await readBody(request);
			const parsed = QuickRunRequestSchema.safeParse(JSON.parse(body.toString("utf8")));
			if (!parsed.success) return json(response, 422, errorBody("INPUT_INVALID", "任务输入格式不正确", false));

			const fingerprint = createHash("sha256").update(body).digest("hex");
			const cached = await readCachedResponse(options.responseCacheDirectory, idempotencyKey);
			if (cached !== null) {
				if (cached.fingerprint !== fingerprint) return json(response, 409, errorBody("IDEMPOTENCY_CONFLICT", "幂等键已被其他输入使用", false));
				return json(response, 200, cached.response, { "X-Idempotent-Replay": "true" });
			}

			let execution = pending.get(idempotencyKey);
			if (execution !== undefined && execution.fingerprint !== fingerprint) {
				return json(response, 409, errorBody("IDEMPOTENCY_CONFLICT", "幂等键已被其他输入使用", false));
			}
			if (execution === undefined) {
				const disconnect = new AbortController();
				request.once("aborted", () => disconnect.abort());
				const timeout = AbortSignal.timeout(options.executionTimeoutMs ?? 180_000);
				execution = {
					fingerprint,
					responsePromise: options
						.execute(parsed.data, AbortSignal.any([disconnect.signal, timeout]))
						.then((value) => QuickAgentResponseSchema.parse(value)),
				};
				pending.set(idempotencyKey, execution);
			}
			try {
				const result = await execution.responsePromise;
				await writeCachedResponse(options.responseCacheDirectory, idempotencyKey, fingerprint, result);
				return json(response, 200, result);
			} finally {
				pending.delete(idempotencyKey);
			}
		} catch (error) {
			if (error instanceof RequestTooLargeError) return json(response, 413, errorBody("INPUT_TOO_LARGE", "请求体超过 1 MiB", false));
			if (error instanceof SyntaxError) return json(response, 400, errorBody("JSON_INVALID", "请求体不是有效 JSON", false));
			// 不把模型响应、任务正文、文件路径或栈信息返回给平台，服务端日志也只记录类别。
			console.error(`[${options.name}] execution failed:`, error instanceof Error ? error.name : "UnknownError");
			return json(response, 500, errorBody("AGENT_EXECUTION_FAILED", "Agent 执行失败，请稍后重试", true));
		}
	});
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const rawChunk of request) {
		const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
		size += chunk.byteLength;
		if (size > MAX_REQUEST_BYTES) throw new RequestTooLargeError();
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

function authorized(request: IncomingMessage, expected: string | undefined): boolean {
	if (expected === undefined) return true;
	const provided = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
	const left = Buffer.from(provided);
	const right = Buffer.from(expected);
	return left.length === right.length && timingSafeEqual(left, right);
}

function json(
	response: ServerResponse,
	status: number,
	body: unknown,
	extraHeaders: Readonly<Record<string, string>> = {},
): void {
	response.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff",
		...extraHeaders,
	});
	response.end(JSON.stringify(body));
}

function errorBody(errorCode: string, message: string, retryable: boolean) {
	return { error_code: errorCode, message, retryable };
}

type CachedResponse = Readonly<{ fingerprint: string; response: QuickAgentResponse }>;

async function readCachedResponse(directory: string, key: string): Promise<CachedResponse | null> {
	try {
		const raw = await readFile(join(directory, cacheFileName(key)), "utf8");
		const decoded = JSON.parse(raw) as { fingerprint?: unknown; response?: unknown };
		if (typeof decoded.fingerprint !== "string") return null;
		const response = QuickAgentResponseSchema.safeParse(decoded.response);
		return response.success ? { fingerprint: decoded.fingerprint, response: response.data } : null;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw error;
	}
}

async function writeCachedResponse(
	directory: string,
	key: string,
	fingerprint: string,
	response: QuickAgentResponse,
): Promise<void> {
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, cacheFileName(key)), JSON.stringify({ fingerprint, response }), { flag: "w" });
}

function cacheFileName(key: string): string {
	return `${createHash("sha256").update(key).digest("hex")}.json`;
}

class RequestTooLargeError extends Error {}
