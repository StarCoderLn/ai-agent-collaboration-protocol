import { z } from "zod";

const InputSchema = z.object({ operation: z.enum(["confirm-deposit", "confirm-settlement"]) }).strict();
const JsonObjectSchema = z.record(z.string(), z.unknown());
const RpcResponseSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: z.unknown() }).strict();

/**
 * 本地链推进只存在于 Next.js 服务端：内部 token 不会下发浏览器，且三项地址门禁确保
 * 该入口不能误连测试网/主网或远端业务服务。它只推进基础设施，不直接改任务状态。
 */
export async function POST(request: Request): Promise<Response> {
	if (process.env.AICP_LOCAL_DEMO_MODE !== "true" || process.env.NODE_ENV === "production") return notFound();
	if (request.headers.get("x-aicp-local-demo") !== "advance") return Response.json({ error: "local demo confirmation header is missing" }, { status: 403 });
	let input: z.infer<typeof InputSchema>;
	try { input = InputSchema.parse(await request.json()); }
	catch { return Response.json({ error: "invalid local demo operation" }, { status: 422 }); }
	try {
		const businessBase = loopbackBase(required("LOCAL_DEMO_BUSINESS_API_URL"), "LOCAL_DEMO_BUSINESS_API_URL");
		const rpcUrl = loopbackBase(required("LOCAL_DEMO_ETHEREUM_RPC_URL"), "LOCAL_DEMO_ETHEREUM_RPC_URL");
		const token = required("DISPATCH_INTERNAL_TOKEN");
		// 本地 Anvil 不会自然发生公链重组；两次确认足以演示“先确认、后匹配”的
		// 业务边界，同时避免每次人工验收都无意义地挖 12 个区块。
		const blocks = positiveInteger(process.env.LOCAL_DEMO_MINE_BLOCKS ?? "2");
		const actions: string[] = [];
		if (input.operation === "confirm-settlement") {
			await runWorker(businessBase, "/api/internal/workers/escrow-execution", token);
			actions.push("escrow-execution");
		}
		await mineBlocks(rpcUrl, blocks);
		actions.push(`mined-${blocks}-blocks`);
		await runWorker(businessBase, "/api/internal/workers/escrow-sync", token);
		actions.push("escrow-sync");
		return Response.json({ localDemo: true, operation: input.operation, actions });
	} catch (error) {
		return Response.json({ error: error instanceof Error ? error.message : "local demo advance failed" }, { status: 502 });
	}
}

async function runWorker(base: string, path: string, token: string): Promise<void> {
	const response = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: "{}",
		signal: AbortSignal.timeout(30_000),
	});
	const raw: unknown = await response.json();
	JsonObjectSchema.parse(raw);
	if (!response.ok) throw new Error(`local worker ${path} returned HTTP ${response.status}`);
}

async function mineBlocks(rpcUrl: string, blocks: number): Promise<void> {
	const response = await fetch(rpcUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_mine", params: [`0x${blocks.toString(16)}`] }),
		signal: AbortSignal.timeout(10_000),
	});
	const raw: unknown = await response.json();
	RpcResponseSchema.parse(raw);
	if (!response.ok) throw new Error(`local Ethereum RPC returned HTTP ${response.status}`);
}

function loopbackBase(value: string, field: string): string {
	const url = new URL(value);
	if ((url.protocol !== "http:" && url.protocol !== "https:") || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) throw new Error(`${field} must use a loopback URL`);
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") throw new Error(`${field} cannot contain credentials, query or fragment`);
	return url.toString().replace(/\/$/, "");
}

function required(name: string): string { const value = process.env[name]; if (value === undefined || value === "") throw new Error(`${name} is required`); return value; }
function positiveInteger(value: string): number { const parsed = Number(value); if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 1_000) throw new Error("LOCAL_DEMO_MINE_BLOCKS must be between 1 and 1000"); return parsed; }
function notFound(): Response { return Response.json({ error: "route not found" }, { status: 404 }); }
