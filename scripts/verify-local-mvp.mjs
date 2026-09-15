#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "../agents/product-workflow/node_modules/zod/index.js";
import { SiweMessage } from "../web/apps/server/node_modules/siwe/dist/siwe.js";

/**
 * 本脚本验证“正在运行的本地产品”，不是在内存中调用 service 的单元测试。
 * 它经过与浏览器相同的 SIWE、Marketplace API、PostgreSQL、Go 调度、Agent 协议回调
 * 和 Anvil Escrow 合约边界，最终覆盖一次返工、验收、结算和评分。
 *
 * 安全边界：只允许 loopback URL 和 Anvil 31337。脚本使用 Anvil 已解锁的公开默认
 * 开发账户签名，不会接受测试网或主网 RPC。下方密钥是 Anvil 文档公开的默认开发密钥，
 * 只能与本脚本的 loopback + Chain 31337 门禁一起使用，绝不能替换为任何真实钱包密钥。
 */

const WEB_ORIGIN = process.env.AICP_WEB_ORIGIN ?? "http://127.0.0.1:3301";
const API_ORIGIN = process.env.AICP_MARKETPLACE_API_ORIGIN ?? "http://127.0.0.1:3100";
const RPC_URL = process.env.AICP_ANVIL_RPC_URL ?? "http://127.0.0.1:8545";
const INTERNAL_TOKEN = process.env.DISPATCH_INTERNAL_TOKEN ?? "aicp-local-internal-token-2026";
// 使用 EIP-55 形式写入 SIWE 消息；siwe v3 会与签名恢复地址做严格字符串比较。
const PUBLISHER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ANVIL_PRIVATE_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ARBITRATOR = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const ARBITRATOR_PRIVATE_KEY = "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const CODE_AGENT_ID = "91000000-0000-4000-8000-000000000007";
const SOFTWARE_CATEGORY_ID = "40000000-0000-4000-8000-000000000023";
const RUN_ID = randomUUID();
const SCENARIO = z.enum(["normal", "dispute-refund"]).parse(process.env.AICP_MVP_SCENARIO ?? "normal");
// 验收任务预算固定为 32 USDC：既能覆盖当前 24 USDC 的快速代码 Agent 报价，
// 又能验证结算时未使用预算退回发布者。所有金额都使用 USDC 的 6 位最小单位。
const ESCROW_AMOUNT_MINOR = "32000000";

const UUID = z.uuid();
const INTEGER = z.string().regex(/^\d+$/);
const ADDRESS = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const HASH = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const NonceSchema = z.object({
	nonce: z.string().min(8), expiresAt: z.iso.datetime(), domain: z.string().min(1),
	uri: z.url(), chainId: z.number().int().positive(), statement: z.string().min(1),
}).passthrough();
const VerifiedSchema = z.object({ walletAddress: ADDRESS }).passthrough();
const CreatedSchema = z.object({ taskId: UUID, status: z.literal("draft"), statusVersion: INTEGER }).passthrough();
const SubmittedSchema = z.object({ taskId: UUID, status: z.literal("awaiting_escrow"), statusVersion: INTEGER }).passthrough();
const EscrowPreparedSchema = z.object({
	taskId: UUID, status: z.literal("prepared"), chainId: INTEGER, contractAddress: ADDRESS,
	paymentTokenAddress: ADDRESS,
	amountMinor: z.literal(ESCROW_AMOUNT_MINOR),
	transactions: z.object({
		approve: z.object({ to: ADDRESS, data: z.string().regex(/^0x[0-9a-fA-F]*$/), value: z.literal("0x0") }),
		deposit: z.object({ to: ADDRESS, data: z.string().regex(/^0x[0-9a-fA-F]*$/), value: z.literal("0x0") }),
	}),
}).passthrough();
const EscrowStatusSchema = z.object({ taskId: UUID, status: z.string(), txHash: HASH.nullable() }).passthrough();
const CandidateRecordSchema = z.object({
	taskId: UUID,
	candidates: z.array(z.object({ agentId: UUID, name: z.string(), quoteMinor: INTEGER }).passthrough()),
}).passthrough();
const AssignmentSchema = z.object({
	assignment: z.object({ id: UUID, taskId: UUID, agentId: UUID, status: z.string() }).passthrough(),
	dispatchAttempt: z.object({ id: UUID, status: z.string() }).passthrough(),
}).passthrough();
const OwnedTasksSchema = z.object({
	tasks: z.array(z.object({ id: UUID, status: z.string(), statusVersion: INTEGER }).passthrough()),
}).passthrough();
const ResultsSchema = z.object({
	taskId: UUID,
	results: z.array(z.object({ id: UUID, batchNo: z.number().int().positive(), isLatest: z.boolean() }).passthrough()),
}).passthrough();
const ReworkSchema = z.object({ taskId: UUID, status: z.literal("rework"), requestId: UUID }).passthrough();
const SettlementSchema = z.object({
	grossAmountMinor: INTEGER,
	platformFeeMinor: INTEGER,
	agentAmountMinor: INTEGER,
	feeRuleVersion: z.string().min(1),
}).strict();
const AcceptancePreviewSchema = z.object({
	taskId: UUID,
	resultId: UUID,
	status: z.literal("awaiting_review"),
	statusVersion: INTEGER,
	settlement: SettlementSchema,
}).passthrough();
const AcceptedSchema = z.object({ taskId: UUID, status: z.literal("pending_settlement"), acceptanceId: UUID }).passthrough();
const RatingSchema = z.object({ taskId: UUID, ratingId: UUID, agentId: UUID }).passthrough();
const DisputeOpenedSchema = z.object({
	disputeId: UUID, taskId: UUID, status: z.literal("evidence_collection"), fundsFrozen: z.literal(true),
	taskStatus: z.literal("disputed"), statusVersion: INTEGER,
}).passthrough();
const DisputeEvidenceSchema = z.object({ disputeId: UUID, evidenceId: UUID, party: z.enum(["publisher", "agent"]) }).passthrough();
const DisputeViewSchema = z.object({
	id: UUID, taskId: UUID, status: z.enum(["evidence_collection", "decided", "executed", "cancelled"]),
	fundsFrozen: z.boolean(), escrowAmountMinor: INTEGER.nullable(), viewerRole: z.enum(["publisher", "agent", "arbitrator"]),
}).passthrough();
const ArbitrationSchema = z.object({
	disputeId: UUID, decisionId: UUID, status: z.literal("decided"), executionStatus: z.literal("decided"),
	decision: z.literal("refund"), releaseAmountMinor: z.literal("0"), refundAmountMinor: z.literal(ESCROW_AMOUNT_MINOR),
}).passthrough();
const RpcSchema = z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number()]), result: z.unknown() }).passthrough();
const WorkerSchema = z.record(z.string(), z.unknown());
const EscrowExecutionWorkerSchema = z.object({
	claimed: z.boolean(),
	jobId: UUID.nullable(),
	status: z.string(),
	txHash: HASH.nullable(),
}).passthrough();
const execFileAsync = promisify(execFile);

await main().catch((error) => {
	console.error(`\n本地 MVP 闭环失败：${error instanceof Error ? error.message : "未知错误"}`);
	process.exitCode = 1;
});

async function main() {
	assertLocalBoundary(WEB_ORIGIN, "AICP_WEB_ORIGIN");
	assertLocalBoundary(API_ORIGIN, "AICP_MARKETPLACE_API_ORIGIN");
	assertLocalBoundary(RPC_URL, "AICP_ANVIL_RPC_URL");
	const chainId = await rpc("eth_chainId", []);
	if (chainId !== "0x7a69") throw new Error(`拒绝运行：RPC Chain ID 为 ${String(chainId)}，预期 Anvil 31337`);

	console.log("1/10 使用 Anvil 本地发布者完成 SIWE 会话");
	const sessionCookie = await createSiweSession(PUBLISHER, ANVIL_PRIVATE_KEY);

	console.log("2/10 创建并提交真实任务草稿");
	const created = await api("/api/tasks", {
		method: "POST", cookie: sessionCookie, key: key("create"), schema: CreatedSchema,
		body: {
			title: `本地闭环验收：可访问任务状态卡片 ${RUN_ID.slice(0, 8)}`,
			description: "实现一个可复用的任务状态卡片，展示进度、负责人、截止时间和主操作，并包含加载、失败、空状态以及 390px 移动端布局。",
			acceptanceCriteria: "交付 Next.js TypeScript 组件；交互按钮可用；覆盖加载、失败和空状态；390px 下无横向溢出；提供关键测试计划。",
			deliverableFormat: "可运行源码、使用说明与测试计划",
			categoryId: SOFTWARE_CATEGORY_ID,
			tags: ["typescript", "next.js", "agent"],
			// 32 USDC；协议边界始终传 6 位最小单位的十进制整数字符串。
			pricing: { type: "fixed", amountMinor: ESCROW_AMOUNT_MINOR },
			currency: "USDC",
			deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
			requiredCapability: "Next.js、TypeScript、React 状态建模和可访问性",
			attachments: [], visibility: "public",
			assignmentMode: { mode: "manual" }, acceptanceMode: { mode: "manual" },
		},
	});
	const taskId = created.taskId;
	await api(`/api/tasks/${taskId}/submit`, { method: "POST", cookie: sessionCookie, key: key("submit"), body: {}, schema: SubmittedSchema });

	console.log("3/10 准备并广播 USDC 授权与 Escrow 托管交易");
	const prepared = await api(`/api/tasks/${taskId}/escrow/prepare`, {
		method: "POST", cookie: sessionCookie, key: key("escrow-prepare"), body: {}, schema: EscrowPreparedSchema,
	});
	if (prepared.chainId !== "31337") throw new Error(`Escrow 返回了非本地 Chain ID：${prepared.chainId}`);
	if (prepared.transactions.approve.to.toLowerCase() !== prepared.paymentTokenAddress.toLowerCase()) {
		throw new Error("USDC 授权交易目标与服务端声明的支付 Token 不一致");
	}
	if (prepared.transactions.deposit.to.toLowerCase() !== prepared.contractAddress.toLowerCase()) {
		throw new Error("存款交易目标与服务端声明的 Escrow 合约不一致");
	}
	// ERC-20 托管必须先精确授权当前任务金额，再调用 Escrow 拉取资金。只把 deposit
	// 的哈希提交给平台，因为它才是托管事实；approve 只改变 Token allowance。
	await rpc("eth_sendTransaction", [{
		from: PUBLISHER,
		to: prepared.transactions.approve.to,
		data: prepared.transactions.approve.data,
		value: prepared.transactions.approve.value,
	}]);
	const txHash = HASH.parse(await rpc("eth_sendTransaction", [{
		from: PUBLISHER,
		to: prepared.transactions.deposit.to,
		data: prepared.transactions.deposit.data,
		value: prepared.transactions.deposit.value,
	}]));
	await api(`/api/tasks/${taskId}/escrow/submission`, {
		method: "POST", cookie: sessionCookie, key: key("escrow-submit"),
		body: { status: "submitted", txHash }, schema: EscrowStatusSchema,
	});
	await advanceChain("escrow-sync");
	await waitForTaskStatus(taskId, sessionCookie, ["matching"], 60_000);

	console.log("4/10 执行真实匹配并选择页面速建师");
	const candidates = await waitForCandidates(taskId, sessionCookie, 60_000);
	if (!candidates.candidates.some((candidate) => candidate.agentId === CODE_AGENT_ID)) {
		throw new Error("匹配结果没有包含已上架的页面速建师");
	}
	const assigned = await api(`/api/tasks/${taskId}/assignments`, {
		method: "POST", cookie: sessionCookie, key: key("assign"), body: { agentId: CODE_AGENT_ID }, schema: AssignmentSchema,
	});
	if (assigned.assignment.agentId !== CODE_AGENT_ID) throw new Error("派发结果的 Agent 与发布者选择不一致");

	console.log("5/10 等待签名派发、Agent 接单、DeepSeek 执行和结果回调");
	const firstResult = await waitForLatestResult(taskId, sessionCookie, null, 12 * 60_000);
	if (SCENARIO === "dispute-refund") {
		await completeDisputeRefund(taskId, firstResult.id, sessionCookie);
		return;
	}

	console.log("6/10 请求返工，并等待同一正式 Agent 生成第二版制品");
	await api(`/api/tasks/${taskId}/rework`, {
		method: "POST", cookie: sessionCookie, key: key("rework"), schema: ReworkSchema,
		body: { resultId: firstResult.id, reason: "请补充键盘焦点状态、错误恢复操作和 390px 移动端验收说明。" },
	});
	const revisedResult = await waitForLatestResult(taskId, sessionCookie, firstResult.id, 12 * 60_000);

	console.log("7/10 验收返工制品并生成待结算记录");
	// 金额、费率版本和任务版本必须来自紧邻提交前的服务端预览；脚本和正式页面都不能
	// 自己重算结算数据，否则状态或费率变化时可能确认用户没有看到过的资金条件。
	const acceptancePreview = await api(
		`/api/tasks/${taskId}/acceptance-preview?resultId=${encodeURIComponent(revisedResult.id)}`,
		{ cookie: sessionCookie, schema: AcceptancePreviewSchema },
	);
	await api(`/api/tasks/${taskId}/accept`, {
		method: "POST", cookie: sessionCookie, key: key("accept"), schema: AcceptedSchema,
		body: {
			resultId: revisedResult.id,
			expectedStatusVersion: acceptancePreview.statusVersion,
			expectedSettlement: acceptancePreview.settlement,
		},
	});

	console.log("8/10 由权威结算 worker 广播交易并确认链上事件");
	await waitForWorkerClaim("/api/internal/workers/escrow-execution");
	await advanceChain("escrow-sync");
	await waitForTaskStatus(taskId, sessionCookie, ["settled"], 60_000);

	console.log("9/10 对已结算任务提交一次真实评分");
	const rating = await api(`/api/tasks/${taskId}/rating`, {
		method: "POST", cookie: sessionCookie, key: key("rating"), schema: RatingSchema,
		body: { quality: 5, communication: 4 },
	});
	if (rating.agentId !== CODE_AGENT_ID) throw new Error("评分没有归属到实际执行 Agent");

	console.log("10/10 核对任务事件审计链");
	const eventTypes = await readTaskEvents(taskId, sessionCookie, 4_000);
	const expectedEvents = [
		"task.submitted", "task.escrow_confirmed", "task.assignment_locked", "task.agent_accepted",
		"task.execution_progress", "task.results_submitted", "task.rework_requested",
		"task.result_accepted", "task.settlement_submitted", "task.settlement_confirmed", "task.rated",
	];
	const missing = expectedEvents.filter((event) => !eventTypes.includes(event));
	if (missing.length > 0) throw new Error(`任务事件审计链缺少：${missing.join("、")}`);

	console.log("\n本地 MVP 真实闭环通过");
	console.log(JSON.stringify({
		taskId, publisher: PUBLISHER, agentId: CODE_AGENT_ID,
		firstResultId: firstResult.id, revisedResultId: revisedResult.id,
		finalStatus: "settled", ratingId: rating.ratingId,
		eventTypes: [...new Set(eventTypes)],
	}, null, 2));
}

/**
 * 争议验收使用两个独立 SIWE 身份：发布者只能举证，Anvil 第二账户只有服务端授予的
 * arbitrator 角色才能决定资金去向。退款仍经 escrow worker 广播并等待链上事件确认，
 * 不能把“数据库已记录决定”误报为“资金已退回”。
 */
async function completeDisputeRefund(taskId, resultId, publisherCookie) {
	console.log("6/10 发布者针对最新交付发起争议并冻结托管资金");
	const opened = await api(`/api/tasks/${taskId}/disputes`, {
		method: "POST", cookie: publisherCookie, key: key("open-dispute"), schema: DisputeOpenedSchema,
		body: {
			reason: "交付没有提供可运行测试证据，无法证明关键失败恢复路径满足验收标准。",
			initialEvidence: { description: `争议针对结果 ${resultId}：缺少可复核的失败恢复测试记录。`, attachments: [] },
		},
	});
	await api(`/api/disputes/${opened.disputeId}/evidence`, {
		method: "POST", cookie: publisherCookie, key: key("dispute-evidence"), schema: DisputeEvidenceSchema,
		body: { description: "补充证据：验收标准要求错误恢复操作，但交付内容没有对应可执行测试。", attachments: [] },
	});
	const publisherView = await api(`/api/disputes/${opened.disputeId}`, { cookie: publisherCookie, schema: DisputeViewSchema });
	if (publisherView.viewerRole !== "publisher" || publisherView.escrowAmountMinor !== ESCROW_AMOUNT_MINOR) {
		throw new Error("争议卷宗没有保持发布者角色或完整托管金额");
	}

	console.log("7/10 使用独立本地仲裁员 SIWE 身份读取卷宗并作出全额退款决定");
	const arbitratorCookie = await createSiweSession(ARBITRATOR, ARBITRATOR_PRIVATE_KEY);
	const arbitratorView = await api(`/api/disputes/${opened.disputeId}`, { cookie: arbitratorCookie, schema: DisputeViewSchema });
	if (arbitratorView.viewerRole !== "arbitrator") throw new Error("本地仲裁账户没有通过服务端角色校验");
	await api(`/api/disputes/${opened.disputeId}/decision`, {
		method: "POST", cookie: arbitratorCookie, key: key("dispute-decision"), schema: ArbitrationSchema,
		body: {
			type: "refund", releaseAmountMinor: "0", refundAmountMinor: ESCROW_AMOUNT_MINOR,
			agentResponsibility: "agent_at_fault", reason: "交付缺少关键验收证据，依据卷宗决定全额退还发布者。",
		},
	});

	console.log("8/10 由权威 worker 广播仲裁退款并等待 Anvil 链上确认");
	await waitForWorkerClaim("/api/internal/workers/escrow-execution");
	await advanceChain("escrow-sync");
	await waitForTaskStatus(taskId, publisherCookie, ["refunded"], 60_000);

	console.log("9/10 核对争议、证据、仲裁和退款事件审计链");
	const eventTypes = await readTaskEvents(taskId, publisherCookie, 4_000);
	const expectedEvents = [
		"task.submitted", "task.escrow_confirmed", "task.assignment_locked", "task.agent_accepted",
		"task.execution_progress", "task.results_submitted", "task.dispute_opened",
		"task.dispute_evidence_submitted", "task.arbitration_decided",
		"task.arbitration_execution_submitted", "task.arbitration_refund_confirmed",
	];
	const missing = expectedEvents.filter((event) => !eventTypes.includes(event));
	if (missing.length > 0) throw new Error(`争议事件审计链缺少：${missing.join("、")}`);

	console.log("10/10 本地争议与链上退款闭环通过");
	console.log(JSON.stringify({
		taskId, disputeId: opened.disputeId, publisher: PUBLISHER, arbitrator: ARBITRATOR,
		agentId: CODE_AGENT_ID, resultId, finalStatus: "refunded", eventTypes: [...new Set(eventTypes)],
	}, null, 2));
}

/** 获取 nonce 时的短期 cookie 与验证后的 session cookie 都只保存在当前进程内。 */
async function createSiweSession(walletAddress, privateKey) {
	const nonceResponse = await fetch(`${API_ORIGIN}/api/auth/nonce`, { headers: { origin: WEB_ORIGIN }, signal: AbortSignal.timeout(10_000) });
	const nonce = NonceSchema.parse(await safeJson(nonceResponse));
	if (!nonceResponse.ok) throw new Error(`SIWE nonce 返回 HTTP ${nonceResponse.status}`);
	if (nonce.chainId !== 31337 || nonce.domain !== new URL(WEB_ORIGIN).host || nonce.uri !== WEB_ORIGIN) {
		throw new Error("SIWE challenge 没有绑定当前本地 Web origin 与 Anvil 31337");
	}
	const nonceCookie = responseCookies(nonceResponse);
	const issuedAt = new Date().toISOString();
	const message = `${nonce.domain} wants you to sign in with your Ethereum account:\n${walletAddress}\n\n${nonce.statement}\n\nURI: ${nonce.uri}\nVersion: 1\nChain ID: ${nonce.chainId}\nNonce: ${nonce.nonce}\nIssued At: ${issuedAt}`;
	// Anvil 1.7.1 的 RPC personal_sign 在本机不能被 siwe v3 按 EIP-191 恢复；cast
	// 明确使用 Ethereum Signed Message 前缀，并通过 execFile 传参，避免 shell 展开消息。
	const signed = await execFileAsync("cast", ["wallet", "sign", "--private-key", privateKey, message], {
		timeout: 10_000, maxBuffer: 16_384, encoding: "utf8",
	});
	const signature = z.string().regex(/^0x[0-9a-fA-F]+$/).parse(signed.stdout.trim());
	// 在发送 HTTP 前用服务端同版本 siwe 库恢复一次地址。若这里失败，说明问题在
	// 本地签名工具；若这里成功而 API 失败，才继续调查 nonce 原子消费或运行时配置。
	let locallyVerified = false;
	let localFailure = "unknown";
	try {
		const localResult = await new SiweMessage(message).verify({
			signature, domain: nonce.domain, nonce: nonce.nonce, time: new Date().toISOString(),
		});
		locallyVerified = localResult.success;
		if (!localResult.success) {
			const failure = localResult.error;
			localFailure = JSON.stringify({ type: failure?.type, expected: failure?.expected, received: failure?.received });
		}
	} catch (error) { localFailure = error instanceof Error ? `${error.name}: ${error.message}` : "non-Error"; }
	if (!locallyVerified) throw new Error(`cast 生成的本地签名无法通过 SIWE 地址恢复：${localFailure}`);
	const verifyResponse = await fetch(`${API_ORIGIN}/api/auth/verify`, {
		method: "POST", headers: { origin: WEB_ORIGIN, cookie: nonceCookie, "content-type": "application/json" },
		body: JSON.stringify({ message, signature }), signal: AbortSignal.timeout(10_000),
	});
	const verifyBody = await safeJson(verifyResponse);
	if (!verifyResponse.ok) throw new Error(`SIWE verify 返回 HTTP ${verifyResponse.status}：${safeError(verifyBody)}`);
	const verified = VerifiedSchema.parse(verifyBody);
	if (verified.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) throw new Error("SIWE 签名恢复出的地址与预期本地账户不一致");
	const sessionCookie = responseCookies(verifyResponse);
	if (sessionCookie === "") throw new Error("SIWE verify 没有返回 httpOnly session cookie");
	return sessionCookie;
}

async function api(path, options) {
	const headers = new Headers({ accept: "application/json", origin: WEB_ORIGIN });
	if (options.cookie !== undefined) headers.set("cookie", options.cookie);
	if (options.body !== undefined) headers.set("content-type", "application/json");
	if (options.key !== undefined) headers.set("idempotency-key", options.key);
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method: options.method ?? "GET", headers,
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
	});
	const raw = await safeJson(response);
	if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} 返回 HTTP ${response.status}：${safeError(raw)}`);
	return options.schema.parse(raw);
}

async function rpc(method, params) {
	const response = await fetch(RPC_URL, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: RUN_ID, method, params }), signal: AbortSignal.timeout(15_000),
	});
	const parsed = RpcSchema.parse(await safeJson(response));
	if (!response.ok) throw new Error(`Anvil RPC ${method} 返回 HTTP ${response.status}`);
	return parsed.result;
}

async function advanceChain(worker) {
	// 本地策略要求 2 次确认；Anvil 不会自然出块，因此显式推进两个区块即可覆盖
	// pending -> confirmed 边界。继续沿用旧脚本的 12 个区块只会增加噪声和等待。
	await rpc("anvil_mine", ["0x2"]);
	await internalWorker(`/api/internal/workers/${worker}`);
}

async function internalWorker(path, schema = WorkerSchema) {
	const response = await fetch(`${API_ORIGIN}${path}`, {
		method: "POST", headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, "content-type": "application/json" },
		body: "{}", signal: AbortSignal.timeout(30_000),
	});
	const parsed = schema.parse(await safeJson(response));
	if (!response.ok) throw new Error(`worker ${path} 返回 HTTP ${response.status}：${safeError(parsed)}`);
	return parsed;
}

/**
 * 验收/仲裁事务会把 `next_attempt_at` 写成数据库当前时间。紧接着触发 worker 时，
 * Node 与 PostgreSQL 的取时可能相差几毫秒，第一次领取合法返回 idle；本地启动器又
 * 没有生产调度器持续补跑，所以验收脚本必须等到作业真正可领取后再挖确认区块。
 */
async function waitForWorkerClaim(path) {
	return poll("Escrow 执行作业", 10_000, async () => {
		const result = await internalWorker(path, EscrowExecutionWorkerSchema);
		return {
			done: result.claimed,
			value: result,
			state: result.claimed ? `${result.status} ${result.jobId ?? "unknown"}` : "等待可领取",
		};
	});
}

async function waitForTaskStatus(taskId, cookie, expected, timeoutMs) {
	return poll(`任务 ${taskId} 状态`, timeoutMs, async () => {
		const body = await api("/api/my-tasks?limit=100&offset=0", { cookie, schema: OwnedTasksSchema });
		const task = body.tasks.find((candidate) => candidate.id === taskId);
		if (task === undefined) throw new Error("已创建任务未出现在发布者工作台");
		return { done: expected.includes(task.status), value: task, state: task.status };
	});
}

async function waitForLatestResult(taskId, cookie, previousId, timeoutMs) {
	return poll(`任务 ${taskId} 制品`, timeoutMs, async () => {
		const [body, owned] = await Promise.all([
			api(`/api/tasks/${taskId}/results`, { cookie, schema: ResultsSchema }),
			api("/api/my-tasks?limit=100&offset=0", { cookie, schema: OwnedTasksSchema }),
		]);
		const task = owned.tasks.find((candidate) => candidate.id === taskId);
		if (task === undefined) throw new Error("已创建任务未出现在发布者工作台");
		if (task.status === "execution_failed") {
			throw new Error(`任务 ${taskId} 的 Agent 执行未完成；平台已记录脱敏失败事件，资金仍在托管中`);
		}
		if (task.status === "timed_out") {
			throw new Error(`任务 ${taskId} 已超时；资金仍需通过争议或退款路径处理`);
		}
		const latest = body.results.find((result) => result.isLatest && result.id !== previousId);
		return { done: latest !== undefined, value: latest, state: latest === undefined ? `${task.status} · 结果数 ${body.results.length}` : `batch ${latest.batchNo}` };
	});
}

async function waitForCandidates(taskId, cookie, timeoutMs) {
	return poll(`任务 ${taskId} 候选记录`, timeoutMs, async () => {
		const response = await fetch(`${API_ORIGIN}/api/tasks/${taskId}/candidates`, {
			headers: { accept: "application/json", cookie, origin: WEB_ORIGIN },
			signal: AbortSignal.timeout(10_000),
		});
		const raw = await safeJson(response);
		if (response.status === 404 && safeError(raw) === "CANDIDATES_NOT_FOUND") {
			return { done: false, value: null, state: "worker 生成中" };
		}
		if (!response.ok) throw new Error(`GET /api/tasks/${taskId}/candidates 返回 HTTP ${response.status}：${safeError(raw)}`);
		const record = CandidateRecordSchema.parse(raw);
		return { done: true, value: record, state: `${record.candidates.length} 个候选` };
	});
}

async function poll(label, timeoutMs, probe) {
	const deadline = Date.now() + timeoutMs;
	let previousState = "";
	while (Date.now() < deadline) {
		const current = await probe();
		if (current.state !== previousState) {
			console.log(`  ${label}：${current.state}`);
			previousState = current.state;
		}
		if (current.done) return current.value;
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	throw new Error(`${label} 在 ${Math.round(timeoutMs / 1_000)} 秒内没有达到预期状态`);
}

async function readTaskEvents(taskId, cookie, timeoutMs) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	const eventTypes = [];
	try {
		const response = await fetch(`${API_ORIGIN}/api/tasks/${taskId}/events/stream`, {
			headers: { accept: "text/event-stream", cookie, origin: WEB_ORIGIN }, signal: controller.signal,
		});
		if (!response.ok || response.body === null) throw new Error(`事件流返回 HTTP ${response.status}`);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		while (!controller.signal.aborted) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const blocks = buffer.split("\n\n");
			buffer = blocks.pop() ?? "";
			for (const block of blocks) {
				const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
				if (eventLine !== undefined) eventTypes.push(eventLine.slice(7));
			}
		}
	} catch (error) {
		if (!controller.signal.aborted) throw error;
	} finally {
		clearTimeout(timeout);
	}
	return eventTypes;
}

function responseCookies(response) {
	const values = typeof response.headers.getSetCookie === "function"
		? response.headers.getSetCookie()
		: [response.headers.get("set-cookie") ?? ""];
	return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function assertLocalBoundary(value, name) {
	const url = new URL(value);
	if (url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
		throw new Error(`${name} 必须使用 loopback HTTP URL`);
	}
	if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
		throw new Error(`${name} 不能包含凭据、查询参数或 fragment`);
	}
}

function key(operation) { return `${operation}:${RUN_ID}`; }
async function safeJson(response) {
	try { return await response.json(); }
	catch { throw new Error(`HTTP ${response.status} 没有返回合法 JSON`); }
}
function safeError(value) {
	if (typeof value === "object" && value !== null) {
		const record = value;
		if (typeof record.error_code === "string") return record.error_code;
		if (typeof record.error === "string") return record.error;
		if (typeof record.message === "string") return record.message;
	}
	return "未知错误";
}
