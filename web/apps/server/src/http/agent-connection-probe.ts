import { lookup } from "node:dns/promises";
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";

import {
	type AgentConnectionProbe,
	type AgentConnectionProbeInput,
	type AgentConnectionProbeResult,
	AgentConnectionTestError,
} from "../agents/agent-connection-test";

const RESPONSE_LIMIT_BYTES = 64 * 1024;
const TIMEOUT_MS = 8_000;

/**
 * 从 Marketplace API 发起连接测试会形成 SSRF 边界。生产环境只允许公网 HTTPS，且 DNS
 * 解析完成后把本次 socket 固定到已校验 IP，防止校验与连接之间发生 DNS rebinding。
 * 本地完整体验显式允许 loopback HTTP，以便测试开发机上的 Agent。
 */
export class HttpAgentConnectionProbe implements AgentConnectionProbe {
	constructor(private readonly allowPrivateNetwork: boolean) {}

	async probe(
		input: AgentConnectionProbeInput,
	): Promise<AgentConnectionProbeResult> {
		const endpoint = new URL(input.serviceEndpoint);
		if (endpoint.username !== "" || endpoint.password !== "") {
			throw new AgentConnectionTestError(
				422,
				"AGENT_ENDPOINT_INVALID",
				"Agent 执行地址不能包含用户名或密码",
				false,
			);
		}
		if (!this.allowPrivateNetwork && endpoint.protocol !== "https:") {
			throw new AgentConnectionTestError(
				422,
				"AGENT_ENDPOINT_HTTPS_REQUIRED",
				"正式环境中的 Agent 执行地址必须使用 HTTPS",
				false,
			);
		}
		if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
			throw new AgentConnectionTestError(
				422,
				"AGENT_ENDPOINT_INVALID",
				"Agent 执行地址必须使用 HTTP(S)",
				false,
			);
		}

		const addresses = await lookup(endpoint.hostname, {
			all: true,
			verbatim: true,
		});
		const allowedAddress = addresses.find(
			(entry) => this.allowPrivateNetwork || isPublicAddress(entry.address),
		);
		if (allowedAddress === undefined) {
			throw new AgentConnectionTestError(
				422,
				"AGENT_ENDPOINT_PRIVATE",
				"Agent 执行地址不能指向平台内部网络",
				false,
			);
		}

		const healthEndpoint = new URL(endpoint);
		healthEndpoint.pathname = "/healthz";
		healthEndpoint.search = "";
		healthEndpoint.hash = "";
		const startedAt = Date.now();
		const body = await requestHealth(
			healthEndpoint,
			allowedAddress.address,
			allowedAddress.family,
			input.credentialSecret,
		);
		let payload: unknown;
		try {
			payload = JSON.parse(body);
		} catch {
			throw new AgentConnectionTestError(
				422,
				"AGENT_HEALTH_INVALID",
				"Agent 健康检查没有返回有效 JSON",
				false,
			);
		}
		const status =
			typeof payload === "object" && payload !== null && "status" in payload
				? (payload as { status?: unknown }).status
				: undefined;
		if (status !== "ok" && status !== "up") {
			throw new AgentConnectionTestError(
				422,
				"AGENT_HEALTH_INVALID",
				"Agent 健康检查需要返回 status: ok 或 up",
				false,
			);
		}
		return { latencyMs: Math.max(0, Date.now() - startedAt) };
	}
}

function requestHealth(
	endpoint: URL,
	address: string,
	family: number,
	credentialSecret: string | undefined,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const pinnedLookup = ((_hostname, _options, callback) => {
			callback(null, address, family);
		}) as LookupFunction;
		const options: RequestOptions = {
			protocol: endpoint.protocol,
			hostname: endpoint.hostname,
			port: endpoint.port === "" ? undefined : Number(endpoint.port),
			method: "GET",
			path: endpoint.pathname,
			lookup: pinnedLookup,
			headers: {
				accept: "application/json",
				"user-agent": "AICP-Agent-Connection-Test/1.0",
				...(credentialSecret === undefined
					? {}
					: { authorization: `Bearer ${credentialSecret}` }),
			},
		};
		const transport =
			endpoint.protocol === "https:" ? httpsRequest : httpRequest;
		const request = transport(options, (response) => {
			if (response.statusCode === 401 || response.statusCode === 403) {
				response.resume();
				reject(
					new AgentConnectionTestError(
						422,
						"AGENT_AUTH_FAILED",
						"访问密钥无效，请检查后重试",
						false,
					),
				);
				return;
			}
			if (
				(response.statusCode ?? 500) < 200 ||
				(response.statusCode ?? 500) >= 300
			) {
				response.resume();
				reject(
					new AgentConnectionTestError(
						422,
						"AGENT_HEALTH_UNAVAILABLE",
						"Agent 的 /healthz 当前不可用",
						true,
					),
				);
				return;
			}
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.byteLength;
				if (size > RESPONSE_LIMIT_BYTES) {
					request.destroy(new Error("health response is too large"));
					return;
				}
				chunks.push(chunk);
			});
			response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
			response.on("error", reject);
		});
		request.setTimeout(TIMEOUT_MS, () =>
			request.destroy(new Error("connection test timeout")),
		);
		request.on("error", reject);
		request.end();
	});
}

function isPublicAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) return isPublicIPv4(address);
	if (version !== 6) return false;
	const normalized = address.toLowerCase();
	if (
		normalized === "::" ||
		normalized === "::1" ||
		normalized.startsWith("fc") ||
		normalized.startsWith("fd") ||
		/^fe[89ab]/.test(normalized) ||
		normalized.startsWith("ff") ||
		normalized.startsWith("2001:db8:")
	)
		return false;
	const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
	return mapped === undefined || isPublicIPv4(mapped);
}

function isPublicIPv4(address: string): boolean {
	const parts = address.split(".").map(Number);
	if (
		parts.length !== 4 ||
		parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
	)
		return false;
	const [first = 0, second = 0, third = 0] = parts;
	if (first === 0 || first === 10 || first === 127 || first >= 224)
		return false;
	if (first === 100 && second >= 64 && second <= 127) return false;
	if (first === 169 && second === 254) return false;
	if (first === 172 && second >= 16 && second <= 31) return false;
	if (first === 192 && (second === 0 || second === 168)) return false;
	if (
		first === 198 &&
		(second === 18 || second === 19 || (second === 51 && third === 100))
	)
		return false;
	if (first === 203 && second === 0 && third === 113) return false;
	return true;
}
