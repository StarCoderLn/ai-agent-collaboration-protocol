const MAX_PROXY_BODY_BYTES = 4 << 20;
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "cookie", "idempotency-key", "last-event-id", "origin"] as const;
const FORWARDED_RESPONSE_HEADERS = ["cache-control", "content-type", "etag", "retry-after", "x-content-type-options", "x-idempotent-replay"] as const;

type ProxyContext = Readonly<{ params: Promise<{ path: string[] }> }>;

/**
 * 本地开发专用的同源 Business API 门面。
 *
 * 它只隐藏“Web 与 Business API 使用不同本机端口”这一部署细节，不实现业务逻辑，
 * 也不注入内部权限。认证 Cookie、幂等键和 Last-Event-ID 原样穿过，响应 body 保持
 * 流式，因此 SIWE、任务写入和 SSE 仍由 Business API 的权威边界处理。
 */
export function GET(request: Request, context: ProxyContext): Promise<Response> { return proxy(request, context); }
export function POST(request: Request, context: ProxyContext): Promise<Response> { return proxy(request, context); }
export function PUT(request: Request, context: ProxyContext): Promise<Response> { return proxy(request, context); }
export function PATCH(request: Request, context: ProxyContext): Promise<Response> { return proxy(request, context); }
export function DELETE(request: Request, context: ProxyContext): Promise<Response> { return proxy(request, context); }

async function proxy(request: Request, context: ProxyContext): Promise<Response> {
	if (process.env.AICP_LOCAL_DEMO_MODE !== "true" || process.env.NODE_ENV === "production") return notFound();
	try {
		const { path } = await context.params;
		const target = targetUrl(path, new URL(request.url).search);
		const headers = new Headers();
		for (const name of FORWARDED_REQUEST_HEADERS) {
			const value = request.headers.get(name);
			if (value !== null) headers.set(name, value);
		}
		const body = request.method === "GET" || request.method === "HEAD" ? undefined : await boundedBody(request);
		const upstream = await fetch(target, {
			method: request.method,
			headers,
			...(body === undefined ? {} : { body }),
			redirect: "manual",
			signal: request.signal,
		});
		const responseHeaders = new Headers();
		for (const name of FORWARDED_RESPONSE_HEADERS) {
			const value = upstream.headers.get(name);
			if (value !== null) responseHeaders.set(name, value);
		}
		const setCookies = typeof upstream.headers.getSetCookie === "function"
			? upstream.headers.getSetCookie()
			: [upstream.headers.get("set-cookie")].filter((value): value is string => value !== null);
		for (const cookie of setCookies) responseHeaders.append("set-cookie", cookie);
		return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
	} catch (error) {
		if (error instanceof ProxyRequestError) return Response.json({ error: error.message }, { status: error.status });
		return Response.json({ error: "local Business API proxy failed" }, { status: 502 });
	}
}

function targetUrl(path: readonly string[], search: string): string {
	if (path.length === 0 || path.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
		throw new ProxyRequestError(404, "route not found");
	}
	const rawBase = process.env.LOCAL_DEMO_BUSINESS_API_URL;
	if (rawBase === undefined || rawBase === "") throw new Error("LOCAL_DEMO_BUSINESS_API_URL is required");
	const base = new URL(rawBase);
	if ((base.protocol !== "http:" && base.protocol !== "https:") || !isLoopback(base.hostname)
		|| base.username !== "" || base.password !== "" || base.search !== "" || base.hash !== "") {
		throw new Error("LOCAL_DEMO_BUSINESS_API_URL must be a credential-free loopback URL");
	}
	const prefix = base.pathname.replace(/\/$/, "");
	base.pathname = `${prefix}/api/${path.map(encodeURIComponent).join("/")}`;
	base.search = search;
	return base.toString();
}

async function boundedBody(request: Request): Promise<ArrayBuffer> {
	const declared = request.headers.get("content-length");
	if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_PROXY_BODY_BYTES) {
		throw new ProxyRequestError(413, "request body exceeds 4 MiB limit");
	}
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > MAX_PROXY_BODY_BYTES) throw new ProxyRequestError(413, "request body exceeds 4 MiB limit");
	return bytes;
}

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
function notFound(): Response { return Response.json({ error: "route not found" }, { status: 404 }); }
class ProxyRequestError extends Error { constructor(readonly status: number, message: string) { super(message); } }
