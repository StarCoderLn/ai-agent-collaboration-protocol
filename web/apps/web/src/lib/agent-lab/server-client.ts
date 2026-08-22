import { request as httpRequest } from "node:http";

const MAX_AGENT_RESPONSE_BYTES = 2 << 20;

export type LocalAgentResponse = {
	status: number;
	body: unknown;
};

/**
 * 调用 loopback Agent 的服务端 HTTP 客户端。
 *
 * Node fetch/Undici 默认约五分钟收不到响应头就会中止，而本地 CPU 推理可能合理地超过
 * 这个时间。这里使用 node:http，让唯一的截止时间来自显式 timeoutMs；同时限制响应体，
 * 防止失控或被替换的本地服务耗尽 Next.js 进程内存。
 */
export function postLocalAgent(
	endpoint: URL,
	headers: Readonly<Record<string, string>>,
	body: Uint8Array,
	timeoutMs: number,
): Promise<LocalAgentResponse> {
	const signal = AbortSignal.timeout(timeoutMs);
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			endpoint,
			{
				method: "POST",
				headers: {
					...headers,
					"Content-Length": body.byteLength.toString(),
				},
				signal,
			},
			(response) => {
				const chunks: Buffer[] = [];
				let receivedBytes = 0;
				response.on("data", (chunk: Buffer | string) => {
					const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
					receivedBytes += buffer.byteLength;
					if (receivedBytes > MAX_AGENT_RESPONSE_BYTES) {
						response.destroy(new Error("Agent response exceeds 2 MiB limit"));
						return;
					}
					chunks.push(buffer);
				});
				response.once("error", reject);
				response.once("end", () => {
					try {
						const rawBody: unknown = JSON.parse(
							Buffer.concat(chunks).toString("utf8"),
						);
						resolve({ status: response.statusCode ?? 502, body: rawBody });
					} catch {
						reject(new Error("Agent response must be valid JSON"));
					}
				});
			},
		);
		request.once("error", reject);
		request.end(Buffer.from(body));
	});
}
