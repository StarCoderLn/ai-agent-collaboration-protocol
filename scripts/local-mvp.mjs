#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "../agents/product-workflow/node_modules/zod/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 所有 Node 子服务复用启动器自身的可执行文件，既保证版本一致，也避免把开发者机器的
// nvm 绝对路径写进仓库。入口处的版本门禁负责确保当前进程满足 Node 22 要求。
const NODE = process.execPath;
const TSX = path.join(ROOT, "agents/product-workflow/node_modules/tsx/dist/cli.mjs");
const NEXT_WEB = path.join(ROOT, "web/apps/web/node_modules/next/dist/bin/next");
const NEXT_BUSINESS = path.join(ROOT, "services/business-api/node_modules/next/dist/bin/next");
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://aicp_test:aicp_test_password@127.0.0.1:55432/aicp_test";
const INTERNAL_TOKEN = process.env.DISPATCH_INTERNAL_TOKEN ?? "aicp-local-internal-token-2026";
const PORTS = Object.freeze({
  anvil: readPort("AICP_ANVIL_PORT", 8545),
  workflow: readPort("AICP_WORKFLOW_AGENT_PORT", 9202),
  business: readPort("AICP_BUSINESS_API_PORT", 3100),
  dispatch: readPort("AICP_DISPATCH_PORT", 3200),
  web: readPort("AICP_WEB_PORT", 3001),
});
const URLS = Object.freeze({
  anvil: `http://127.0.0.1:${PORTS.anvil}`,
  workflow: `http://127.0.0.1:${PORTS.workflow}`,
  business: `http://127.0.0.1:${PORTS.business}`,
  dispatch: `http://127.0.0.1:${PORTS.dispatch}`,
  web: `http://127.0.0.1:${PORTS.web}`,
});
const ANVIL_ACCOUNT = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
// 这是 Anvil 文档公开的默认开发私钥，只能在 loopback chain 31337 使用，绝不能用于任何真实网络。
const ANVIL_PRIVATE_KEY = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const children = [];
let startupComplete = false;
let shuttingDown = false;

const ServiceStatusSchema = z.object({ status: z.enum(["ok", "up"]) }).passthrough();
const WorkflowStatusSchema = ServiceStatusSchema.extend({ service: z.literal("product-workflow-agents") });
const RpcResponseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown(),
}).passthrough();
const EscrowExecutionResultSchema = z.object({
  claimed: z.boolean(),
  status: z.enum(["idle", "submitted", "retry_pending", "dead_letter"]),
}).passthrough();
const WorkerResultSchema = z.record(z.string(), z.unknown());

if (process.env.AICP_LOCAL_MVP_TEST_MODE !== "true") {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "local MVP startup failed");
    shutdown(1);
  });
}

async function main() {
  assertSupportedNodeVersion();
  assertLoopbackUrl(DATABASE_URL, "DATABASE_URL");
  assertDistinctPorts(PORTS);
  const evidenceEnv = parseEnv(await readFile(path.join(ROOT, "agents/evidence-research/.env"), "utf8"));
  const apiKey = required(evidenceEnv, "DEEPSEEK_API_KEY");
  const agentSecret = required(evidenceEnv, "EVIDENCE_AGENT_SECRET");
  if (agentSecret.length < 16) throw new Error("EVIDENCE_AGENT_SECRET must contain at least 16 characters");

  // 应用服务携带数据库、内部 token 与本次部署的 Escrow 地址。仅看端口或普通 health
  // 无法证明这些配置相容，所以已占用时明确失败；用户可通过 AICP_*_PORT 选择隔离端口。
  // 这项预检必须发生在启动 Anvil、部署合约或写 bootstrap 数据之前，保证失败无副作用。
  await assertApplicationPortsAvailable();

  if (!(await portOpen(PORTS.anvil))) {
    const anvil = start("Anvil", "anvil", ["--host", "127.0.0.1", "--port", String(PORTS.anvil), "--chain-id", "31337"]);
    await waitForService(anvil, "Anvil", () => probeAnvil());
  }
  const chainId = await rpc("eth_chainId", []);
  if (chainId !== "0x7a69") throw new Error(`${URLS.anvil} is not Anvil chain 31337`);
  const { escrowAddress, paymentTokenAddress } = await deployLocalMoneyContracts();

  await runOnce("本地链同步游标", NODE, [path.join(ROOT, "scripts/local-chain-bootstrap.mjs")], {
    cwd: ROOT,
    env: {
      AICP_LOCAL_DEMO_MODE: "true",
      DATABASE_URL,
      ESCROW_CHAIN_ID: "31337",
      ESCROW_CONTRACT_ADDRESS: escrowAddress,
    },
  });

  await runOnce("本地 9-Agent 目录", NODE, [TSX, "src/local-bootstrap.ts"], {
    cwd: path.join(ROOT, "agents/product-workflow"),
    env: { AICP_LOCAL_DEMO_MODE: "true", DATABASE_URL, WORKFLOW_AGENT_PUBLIC_URL: URLS.workflow },
  });

	// 本地 MVP 是开发验收入口，Agent 源码变化后应与 Next.js 一样自动重载；否则页面
	// 会继续调用旧协议实现，造成“测试已通过但浏览器仍失败”的假象。
  const workflow = start("Product Workflow Agent", NODE, [TSX, "watch", "src/index.ts"], {
    cwd: path.join(ROOT, "agents/product-workflow"),
    env: {
      DEEPSEEK_API_KEY: apiKey,
      DEEPSEEK_BASE_URL: evidenceEnv.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      // 论文调研可以使用推理模型，但结构化工作流默认使用非推理 chat 模型。两者不能
      // 复用同一个模型变量，否则 reasoning token 会挤占 Coding JSON 的输出预算。
      WORKFLOW_AGENT_MODEL: process.env.WORKFLOW_AGENT_MODEL ?? evidenceEnv.WORKFLOW_AGENT_MODEL ?? "deepseek-chat",
      WORKFLOW_AGENT_SECRET: agentSecret,
      WORKFLOW_AGENT_HOST: "127.0.0.1",
      WORKFLOW_AGENT_PORT: String(PORTS.workflow),
    },
  });
  await waitForService(workflow, "Product Workflow Agent", () => probeJson(`${URLS.workflow}/livez`, WorkflowStatusSchema));

  const business = start("Business API", NODE, [NEXT_BUSINESS, "dev", "--hostname", "127.0.0.1", "--port", String(PORTS.business)], {
    cwd: path.join(ROOT, "services/business-api"),
    env: {
      AICP_LOCAL_DEMO_MODE: "true",
      DATABASE_URL,
      SIWE_EXPECTED_DOMAIN: `127.0.0.1:${PORTS.web}`,
      SIWE_EXPECTED_URI: URLS.web,
      SIWE_EXPECTED_CHAIN_ID: "31337",
      DISPATCH_ENGINE_URL: URLS.dispatch,
      DISPATCH_INTERNAL_TOKEN: INTERNAL_TOKEN,
      ETHEREUM_RPC_URL: URLS.anvil,
      ESCROW_CHAIN_ID: "31337",
      ESCROW_CONTRACT_ADDRESS: escrowAddress,
      ESCROW_PAYMENT_TOKEN_ADDRESS: paymentTokenAddress,
      ESCROW_START_BLOCK: "0",
      // Anvil 的区块只由本地操作推进，不存在自然出块带来的等待价值。保留 2 次确认
      // 可验证 pending -> confirmed 边界，又不会让产品体验被底层演示参数拖慢。
      ESCROW_REQUIRED_CONFIRMATIONS: "2",
      ESCROW_OPERATOR_MODE: "local-unlocked",
      ESCROW_OPERATOR_ADDRESS: ANVIL_ACCOUNT,
    },
  });
  await waitForService(business, "Business API", () => probeJson(`${URLS.business}/api/health`, ServiceStatusSchema));

  const dispatch = start("Dispatch Engine", "go", ["run", "./cmd/server"], {
    cwd: path.join(ROOT, "services/dispatch-engine"),
    env: {
      DATABASE_URL,
      DISPATCH_INTERNAL_TOKEN: INTERNAL_TOKEN,
      BUSINESS_API_URL: URLS.business,
      DISPATCH_HTTP_ADDRESS: `127.0.0.1:${PORTS.dispatch}`,
      DISPATCH_PUBLIC_URL: URLS.dispatch,
      DISPATCH_QUEUE_MODE: "local",
      LOCAL_AGENT_SECRET: agentSecret,
    },
  });
  await waitForService(dispatch, "Dispatch Engine", () => probeJson(`${URLS.dispatch}/health`, ServiceStatusSchema));

  // 公链会自然出块，生产环境也会由定时 worker 处理资金 outbox；Anvil 两者都没有。
  // 本地启动器因此只在真实领取到结算任务时挖确认块并同步事件，让中间阶段自动验收后
  // 能完整进入已确认结算，不再依赖用户点击隐藏的“推进本地链”操作。
  void runLocalSettlementAdvancer().catch(() => {
    if (!shuttingDown) console.error("本地结算自动推进器异常退出");
  });

  const web = start("Web", NODE, [NEXT_WEB, "dev", "--hostname", "127.0.0.1", "--port", String(PORTS.web)], {
    cwd: path.join(ROOT, "web/apps/web"),
    env: {
	  // 与用户可能已运行的默认 `.next/dev` 隔离；目录已被 Web 工程 gitignore 覆盖。
	  AICP_NEXT_DIST_DIR: "dev-dist/local-mvp",
      NEXT_PUBLIC_SERVER_URL: URLS.web,
      NEXT_PUBLIC_BUSINESS_API_URL: `${URLS.business}/api`,
      NEXT_PUBLIC_ETHEREUM_RPC_URL: URLS.anvil,
      NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE: "true",
      AICP_LOCAL_DEMO_MODE: "true",
      LOCAL_DEMO_BUSINESS_API_URL: URLS.business,
      LOCAL_DEMO_ETHEREUM_RPC_URL: URLS.anvil,
      LOCAL_DEMO_MINE_BLOCKS: "2",
      DISPATCH_INTERNAL_TOKEN: INTERNAL_TOKEN,
      WORKFLOW_AGENT_URL: `${URLS.workflow}/v1/workflow/execute`,
      WORKFLOW_AGENT_SECRET: agentSecret,
    },
  });
  await waitForService(web, "Web", () => probeWeb());

  startupComplete = true;
  console.log(`\nAICP 本地完整闭环已启动：${URLS.web}`);
  console.log(`Escrow 合约：${escrowAddress}`);
  console.log(`测试 USDC：${paymentTokenAddress}（默认 Anvil 账户已获得 100,000 USDC）`);
  console.log(`MetaMask 网络：Anvil 31337 / ${URLS.anvil} / 默认账户 ${ANVIL_ACCOUNT}`);
  console.log("按 Ctrl+C 会关闭本启动器创建的全部进程。\n");
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  await new Promise(() => undefined);
}

function assertSupportedNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`local MVP requires Node.js 22 or newer; current version is ${process.versions.node}`);
  }
}

/**
 * 本地链每次启动都部署一对全新的测试 USDC 与 Escrow，并只给 Anvil 默认账户铸币。
 * 测试 Token 的 mint 权限绝不能出现在公共测试网/生产部署路径；正式环境必须通过
 * ESCROW_PAYMENT_TOKEN_ADDRESS 注入官方 USDC，且不会调用本函数。
 */
async function deployLocalMoneyContracts() {
  const paymentTokenAddress = await deployContract("test/TestUSDC.sol:TestUSDC", []);
  const escrowAddress = await deployContract("src/Escrow.sol:Escrow", [
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    paymentTokenAddress,
  ]);
  await capture("cast", [
    "send", paymentTokenAddress, "mint(address,uint256)", ANVIL_ACCOUNT, "100000000000",
    "--rpc-url", URLS.anvil, "--private-key", ANVIL_PRIVATE_KEY,
  ], path.join(ROOT, "contracts/escrow"));
  return { escrowAddress, paymentTokenAddress };
}

async function deployContract(contract, constructorArgs) {
  const args = [
    "create", contract, "--broadcast", "--json",
    "--rpc-url", URLS.anvil, "--private-key", ANVIL_PRIVATE_KEY,
  ];
  if (constructorArgs.length > 0) args.push("--constructor-args", ...constructorArgs);
  const output = await capture("forge", args, path.join(ROOT, "contracts/escrow"));
  const matched = /"deployedTo"\s*:\s*"(0x[0-9a-fA-F]{40})"/.exec(output)
    ?? /Deployed to:\s*(0x[0-9a-fA-F]{40})/.exec(output);
  if (matched?.[1] === undefined) throw new Error(`${contract} deployment did not return a contract address`);
  return matched[1].toLowerCase();
}

function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdio: "inherit",
  });
  const exit = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const managed = { child, exit };
  children.push(managed);
  exit.then((outcome) => {
    if (shuttingDown) return;
    const reason = "error" in outcome
      ? outcome.error.message
      : outcome.signal === null ? `code ${outcome.code}` : `signal ${outcome.signal}`;
    console.error(`${label} exited unexpectedly with ${reason}`);
    if (startupComplete) shutdown(1);
  });
  return managed;
}

async function runOnce(label, command, args, options) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (value) => resolve(value));
  });
  if (code !== 0) throw new Error(`${label} failed with code ${code}`);
}

async function capture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(`${stdout}\n${stderr}`) : reject(new Error(`${command} failed: ${stderr.slice(-500)}`)));
  });
}

async function rpc(method, params) {
  const response = await fetch(URLS.anvil, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(2_000),
  });
  const body = RpcResponseSchema.safeParse(await response.json());
  if (!response.ok || !body.success) throw new Error(`Anvil RPC ${method} failed`);
  return body.data.result;
}

async function runLocalSettlementAdvancer() {
  while (!shuttingDown) {
    try {
      await advanceLocalSettlementOnce(runInternalWorker, mineLocalConfirmationBlocks);
    } catch {
      // 服务刚重载或链短暂不可用时保留 outbox 的重试语义；不输出响应和内部 token。
      if (!shuttingDown) console.error("本地结算自动推进失败，将在下一轮重试");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * 一轮只在资金 worker 真正广播了交易后挖块并同步，避免空闲时每秒制造无意义区块。
 * 依赖以函数参数注入仅用于纯测试；正式启动始终使用下方受 loopback 与内部 token 约束的实现。
 */
async function advanceLocalSettlementOnce(runWorker, mineBlocks) {
  const rawExecution = await runWorker("/api/internal/workers/escrow-execution");
  const execution = EscrowExecutionResultSchema.parse(rawExecution);
  // retry_pending / dead_letter 代表链上交易没有广播，不能挖块后伪装成已确认。
  if (!execution.claimed || execution.status !== "submitted") return false;
  await mineBlocks();
  await runWorker("/api/internal/workers/escrow-sync");
  return true;
}

async function runInternalWorker(pathname) {
  const response = await fetch(`${URLS.business}${pathname}`, {
    method: "POST",
    headers: { authorization: `Bearer ${INTERNAL_TOKEN}`, "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(30_000),
  });
  const parsed = WorkerResultSchema.safeParse(await response.json());
  if (!response.ok || !parsed.success) throw new Error(`local worker ${pathname} failed`);
  return parsed.data;
}

async function mineLocalConfirmationBlocks() {
  const blocks = positiveInteger(process.env.LOCAL_DEMO_MINE_BLOCKS ?? "2");
  await rpc("anvil_mine", [`0x${blocks.toString(16)}`]);
}

function parseEnv(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    const matched = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (matched?.[1] !== undefined && matched[2] !== undefined) result[matched[1]] = matched[2].replace(/^['"]|['"]$/g, "");
  }
  return result;
}

function required(record, name) { const value = record[name]; if (typeof value !== "string" || value === "") throw new Error(`${name} is missing from agents/evidence-research/.env`); return value; }
function assertLoopbackUrl(value, name) { const host = new URL(value).hostname; if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) throw new Error(`${name} must point to loopback`); }
function portOpen(port) { return new Promise((resolve) => { const socket = net.createConnection({ host: "127.0.0.1", port }); socket.setTimeout(300); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("timeout", () => { socket.destroy(); resolve(false); }); socket.once("error", () => resolve(false)); }); }

function readPort(name, fallback) {
  const parsed = z.coerce.number().int().min(1).max(65_535).safeParse(process.env[name] ?? fallback);
  if (!parsed.success) throw new Error(`${name} must be an integer between 1 and 65535`);
  return parsed.data;
}

function positiveInteger(value) {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 1_000) {
    throw new Error("LOCAL_DEMO_MINE_BLOCKS must be between 1 and 1000");
  }
  return parsed;
}

function assertDistinctPorts(ports) {
  const values = Object.values(ports);
  if (new Set(values).size !== values.length) throw new Error("AICP local service ports must be distinct");
}

async function assertApplicationPortsAvailable() {
  const services = [
    ["Web", PORTS.web, "AICP_WEB_PORT"],
    ["Product Workflow Agent", PORTS.workflow, "AICP_WORKFLOW_AGENT_PORT"],
    ["Business API", PORTS.business, "AICP_BUSINESS_API_PORT"],
    ["Dispatch Engine", PORTS.dispatch, "AICP_DISPATCH_PORT"],
  ];
  return assertPortsAvailable(services, portOpen);
}

/**
 * 端口门禁的纯逻辑边界。把探测函数作为参数只为测试失败路径，不暴露给启动器调用方；
 * 真正启动始终使用上面的 loopback TCP 探测，避免测试替身进入生产运行路径。
 */
async function assertPortsAvailable(services, isOpen) {
  const occupied = [];
  for (const [label, port, variable] of services) {
    if (await isOpen(port)) occupied.push(`${label} 使用的 ${port}（可通过 ${variable} 更换）`);
  }
  if (occupied.length > 0) {
    throw new Error(`启动前发现应用端口已占用；为避免复用配置不一致的旧进程，本次未执行任何写操作：\n- ${occupied.join("\n- ")}`);
  }
}

async function waitForService(managed, label, probe) {
	// 子进程退出必须参与每一次探测和退避等待。若在外层用一个 30 秒轮询 Promise
	// 与退出事件只竞速一次，失败结果返回后落败的轮询仍会保留计时器，导致测试和
	// 启动失败路径无意义地挂住 30 秒。
	const exitFailure = managed.exit.then((outcome) => {
		if ("error" in outcome) throw new Error(`${label} failed to spawn: ${outcome.error.message}`);
		const reason = outcome.signal === null ? `code ${outcome.code}` : `signal ${outcome.signal}`;
		throw new Error(`${label} exited before becoming ready with ${reason}`);
	});
	for (let attempt = 0; attempt < 120; attempt += 1) {
		if (await Promise.race([probe(), exitFailure])) return;
		await Promise.race([
			new Promise((resolve) => setTimeout(resolve, 250)),
			exitFailure,
		]);
	}
	throw new Error(`${label} did not pass its readiness contract within 30 seconds`);
}

async function probeJson(url, schema) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(750) });
    if (!response.ok) return false;
    return schema.safeParse(await response.json()).success;
  } catch {
    return false;
  }
}

async function probeAnvil() {
  try { return await rpc("eth_chainId", []) === "0x7a69"; }
  catch { return false; }
}

async function probeWeb() {
  try {
    const response = await fetch(URLS.web, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    return isReadyWebHtml(await response.text());
  } catch {
    return false;
  }
}

/**
 * Web 就绪检查只依赖跨语言、跨营销改版都稳定的产品壳标志。首页标题和宣传文案会持续
 * 迭代，不应成为进程存活契约；否则页面已经正常返回 200 时，启动器仍会误杀整组服务。
 */
function isReadyWebHtml(html) {
  return html.includes("<title>AICP ·")
    && html.includes('href="/tasks"')
    && html.includes('href="/agents"');
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(code);
}

export {
  advanceLocalSettlementOnce,
  assertPortsAvailable,
  isReadyWebHtml,
  waitForService,
};
