#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "../agents/product-workflow/node_modules/zod/index.js";
import {
  LOCAL_DATABASE_URL,
  LOCAL_INTERNAL_TOKEN,
} from "./local-runtime-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 所有 Node 子服务复用启动器自身的可执行文件，既保证版本一致，也避免把开发者机器的
// nvm 绝对路径写进仓库。入口处的版本门禁负责确保当前进程满足 Node 22 要求。
const NODE = process.execPath;
const TSX = path.join(ROOT, "agents/product-workflow/node_modules/tsx/dist/cli.mjs");
const SDK_TSC = path.join(ROOT, "agents/agent-sdk/node_modules/typescript/bin/tsc");
const NEXT_WEB = path.join(ROOT, "web/apps/web/node_modules/next/dist/bin/next");
const NEXT_BUSINESS = path.join(ROOT, "services/business-api/node_modules/next/dist/bin/next");
const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const INTERNAL_TOKEN = process.env.DISPATCH_INTERNAL_TOKEN ?? LOCAL_INTERNAL_TOKEN;
const LOCAL_CHAIN_DIRECTORY = path.join(ROOT, ".local/anvil");
const LOCAL_CHAIN_STATE_PATH = path.join(LOCAL_CHAIN_DIRECTORY, "state.json");
const LOCAL_CHAIN_DEPLOYMENT_PATH = path.join(LOCAL_CHAIN_DIRECTORY, "deployment.json");
// 新建本地 DAO 使用已确认的启动期门槛；恢复旧链仍读取部署清单，不在启动时偷偷发交易改配置。
const LOCAL_DAO_MINIMUM_STAKE_MINOR = (100n * 10n ** 18n).toString();
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
let shutdownPromise;
let localRewardEnabled = false;

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
const LegacyLocalDeploymentSchema = z.object({
  version: z.literal(1),
  chainId: z.literal(31_337),
  paymentTokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase()),
  escrowAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase()),
  createdAt: z.iso.datetime(),
}).strict();
const LocalDeploymentSchema = z.object({
  version: z.literal(2),
  chainId: z.literal(31_337),
  paymentTokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase()),
  escrowAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase()),
  ydTokenAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase()),
  arbitrationDaoAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((value) => value.toLowerCase()),
  daoMinimumStakeMinor: z.string().regex(/^[1-9]\d*$/),
  createdAt: z.iso.datetime(),
}).strict();
const SupportedLocalDeploymentSchema = z.discriminatedUnion("version", [
  LegacyLocalDeploymentSchema,
  LocalDeploymentSchema,
]);

if (process.env.AICP_LOCAL_MVP_TEST_MODE !== "true") {
  await main().catch(async (error) => {
    console.error(error instanceof Error ? error.message : "local MVP startup failed");
    await shutdown(1);
  });
}

async function main() {
  assertSupportedNodeVersion();
  const command = parseLocalMvpCommand(process.argv.slice(2));
  if (command === "reset-chain") {
    await resetLocalChainState();
    return;
  }
  assertLoopbackUrl(DATABASE_URL, "DATABASE_URL");
  assertDistinctPorts(PORTS);
  const paperEnv = parseEnv(await readFile(path.join(ROOT, "agents/paper-writing/.env"), "utf8"));
  const apiKey = required(paperEnv, "DEEPSEEK_API_KEY");
  const agentSecret = required(paperEnv, "WORKFLOW_AGENT_SECRET");
  if (agentSecret.length < 16) throw new Error("WORKFLOW_AGENT_SECRET must contain at least 16 characters");

  // 应用服务携带数据库、内部 token 与本次部署的 Escrow 地址。仅看端口或普通 health
  // 无法证明这些配置相容，所以已占用时明确失败；用户可通过 AICP_*_PORT 选择隔离端口。
  // 这项预检必须发生在启动 Anvil、部署合约或写 bootstrap 数据之前，保证失败无副作用。
  await assertApplicationPortsAvailable();

  const { deployment, mode } = await startPersistentLocalChain();
  const { escrowAddress, paymentTokenAddress, ydTokenAddress, arbitrationDaoAddress, daoMinimumStakeMinor } = deployment;

  // Next.js 从 API 工程的 .env.local 读取本地奖励目录，启动器也读取相同开关以恢复调度。
  // 不向其他服务散播文件中的凭据；显式进程变量优先，缺失文件代表未启用而非自动部署。
  const apiLocalEnv = await readFile(path.join(ROOT, "services/business-api/.env.local"), "utf8")
    .catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  localRewardEnabled = isLocalRewardWorkerEnabled({ ...parseEnv(apiLocalEnv), ...process.env });

  // 只有 genesis 链需要删除同地址旧链留下的同步游标；恢复链沿用原区块高度，重置游标
  // 会让同步器从头扫描并增加重复事件处理压力，甚至掩盖错误恢复配置。
  if (mode === "fresh" || mode === "upgrade") {
    await runOnce("本地链同步游标", NODE, [path.join(ROOT, "scripts/local-chain-bootstrap.mjs")], {
      cwd: ROOT,
      env: {
        AICP_LOCAL_DEMO_MODE: "true",
        DATABASE_URL,
        ESCROW_CHAIN_ID: "31337",
        ESCROW_CONTRACT_ADDRESS: escrowAddress,
      },
    });
  }

  // 内置 Agent 通过 workspace 依赖消费与第三方相同的 SDK。启动器先编译 SDK，保证
  // 全新 clone 不依赖未提交的 dist 目录，同时让 watch 进程始终加载当前协议实现。
  await runOnce("Agent SDK", NODE, [SDK_TSC, "-p", "tsconfig.build.json"], {
    cwd: path.join(ROOT, "agents/agent-sdk"),
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
      DEEPSEEK_BASE_URL: paperEnv.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
      // 论文调研可以使用推理模型，但结构化工作流默认使用非推理 chat 模型。两者不能
      // 复用同一个模型变量，否则 reasoning token 会挤占 Coding JSON 的输出预算。
      WORKFLOW_AGENT_MODEL: process.env.WORKFLOW_AGENT_MODEL ?? paperEnv.WORKFLOW_AGENT_MODEL ?? "deepseek-chat",
      WORKFLOW_AGENT_SECRET: agentSecret,
      WORKFLOW_AGENT_HOST: "127.0.0.1",
      WORKFLOW_AGENT_PORT: String(PORTS.workflow),
      DATABASE_URL,
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
      ARBITRATION_DAO_CHAIN_ID: "31337",
      ARBITRATION_DAO_CONTRACT_ADDRESS: arbitrationDaoAddress,
      // 本地 DAO 必须与 Anvil Escrow 同链，因此使用专属 TestYD；不要写入
      // YD_TOKEN_*，后者属于工作台展示的 Sepolia 产品 YD 配置。
      ARBITRATION_DAO_YD_TOKEN_ADDRESS: ydTokenAddress,
      ARBITRATION_DAO_MINIMUM_STAKE_MINOR: daoMinimumStakeMinor,
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
	  // 自动准入在三次技术调用全部通过后仅发起一次批量评测；复用开发者已经配置的
	  // DeepSeek 密钥，不再要求为审核流程维护第二套本地凭证。
	  DEEPSEEK_API_KEY: apiKey,
	  DEEPSEEK_BASE_URL: paperEnv.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
	  AGENT_ADMISSION_EVALUATOR_MODEL: process.env.AGENT_ADMISSION_EVALUATOR_MODEL ?? "deepseek-chat",
	  AGENT_ADMISSION_ENGINE: process.env.AGENT_ADMISSION_ENGINE ?? "postgres",
	  TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
	  TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE ?? "default",
	  TEMPORAL_ADMISSION_TASK_QUEUE: process.env.TEMPORAL_ADMISSION_TASK_QUEUE ?? "aicp-agent-admission-v1",
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
	  // 交易详情只解析当前启动实例的已知合约日志；把公开地址显式传给 Web，避免
	  // 仅凭事件签名把其他合约误标成平台资金或 DAO 操作。
	  NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS: escrowAddress,
	  NEXT_PUBLIC_ESCROW_PAYMENT_TOKEN_ADDRESS: paymentTokenAddress,
      NEXT_PUBLIC_ARBITRATION_DAO_ADDRESS: arbitrationDaoAddress,
	  NEXT_PUBLIC_ARBITRATION_DAO_YD_TOKEN_ADDRESS: ydTokenAddress,
      NEXT_PUBLIC_ARBITRATION_DAO_MINIMUM_STAKE_MINOR: daoMinimumStakeMinor,
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
  console.log(`本地链状态：${mode === "fresh" ? "首次创建" : "已从磁盘恢复"}`);
  console.log(`Escrow 合约：${escrowAddress}`);
  console.log(`测试 USDC：${paymentTokenAddress}（默认 Anvil 账户已获得 100,000 USDC）`);
  console.log(`本地 DAO TestYD：${ydTokenAddress}（默认 Anvil 账户已获得 10,000 TestYD）`);
  console.log(`DAO 仲裁质押：${arbitrationDaoAddress}（最低 ${formatLocalYd(daoMinimumStakeMinor)} YD）`);
  console.log(`MetaMask 网络：Anvil 31337 / ${URLS.anvil} / 默认账户 ${ANVIL_ACCOUNT}`);
  console.log("按 Ctrl+C 会关闭本启动器创建的全部进程。\n");
  process.on("SIGINT", () => { void shutdown(0); });
  process.on("SIGTERM", () => { void shutdown(0); });
  await new Promise(() => undefined);
}

function assertSupportedNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`local MVP requires Node.js 22 or newer; current version is ${process.versions.node}`);
  }
}

/**
 * 项目私有的状态文件和部署清单共同组成一个可恢复单元。二者缺一时拒绝启动，避免把旧
 * PostgreSQL 业务记录连接到一条新 genesis 链，也避免拿旧合约地址读取不相干的状态。
 */
async function startPersistentLocalChain() {
  const [stateExists, deploymentExists] = await Promise.all([
    fileExists(LOCAL_CHAIN_STATE_PATH),
    fileExists(LOCAL_CHAIN_DEPLOYMENT_PATH),
  ]);
  const mode = resolveLocalChainMode(stateExists, deploymentExists);
  if (await portOpen(PORTS.anvil)) {
    throw new Error(`${URLS.anvil} 已被占用；持久化本地链必须由当前启动器独占管理，请先关闭旧进程`);
  }

  await mkdir(LOCAL_CHAIN_DIRECTORY, { recursive: true });
  const restoredDeployment = mode === "restore"
    ? parseLocalDeployment(await readFile(LOCAL_CHAIN_DEPLOYMENT_PATH, "utf8"))
    : undefined;
  const anvil = start("Anvil", "anvil", buildAnvilArguments({
    host: "127.0.0.1",
    port: PORTS.anvil,
    chainId: 31_337,
    statePath: LOCAL_CHAIN_STATE_PATH,
  }));
  await waitForService(anvil, "Anvil", () => probeAnvil());

  if (restoredDeployment !== undefined) {
    await validateLocalDeployment(restoredDeployment, rpc);
    // 旧版快照只保存最新状态，恢复后 latest-1 的 eth_call 会报 BlockOutOfRange。
    // 本地两次确认需要可读的历史状态；补两个空块完成旧快照兼容，不重置余额或历史交易。
    // 从此启动参数同时保存历史状态，之后重启可继续读取这些已确认区块。
    await rpc("anvil_mine", ["0x2"]);
    if (restoredDeployment.version === 2) return { deployment: restoredDeployment, mode };

    // v1 持久化链包含真实历史任务，不能为了升级合约删除 state.json。新部署的 Escrow
    // 与 DAO 使用新地址，旧任务仍按各自 escrow_intents 中固化的旧地址完成历史审计。
    const upgradedContracts = await deployLocalMoneyContracts(restoredDeployment.paymentTokenAddress);
    const upgradedDeployment = {
      version: 2,
      chainId: 31_337,
      ...upgradedContracts,
      createdAt: new Date().toISOString(),
    };
    await waitForStateSnapshot(LOCAL_CHAIN_STATE_PATH, Date.now());
    await writeJsonAtomically(LOCAL_CHAIN_DEPLOYMENT_PATH, upgradedDeployment);
    await validateLocalDeployment(upgradedDeployment, rpc);
    return { deployment: upgradedDeployment, mode: "upgrade" };
  }

  const deployedContracts = await deployLocalMoneyContracts();
  const deployment = {
    version: 2,
    chainId: 31_337,
    ...deployedContracts,
    createdAt: new Date().toISOString(),
  };
  // Anvil 可能已在部署前写过一次 genesis 快照。必须等待部署完成后的新落盘，再写部署
  // 清单；这样即使机器在任意时刻断电，下次也只会恢复完整状态或明确报告残缺状态。
  await waitForStateSnapshot(LOCAL_CHAIN_STATE_PATH, Date.now());
  await writeJsonAtomically(LOCAL_CHAIN_DEPLOYMENT_PATH, deployment);
  await validateLocalDeployment(deployment, rpc);
  return { deployment, mode };
}

function resolveLocalChainMode(stateExists, deploymentExists) {
  if (!stateExists && !deploymentExists) return "fresh";
  if (stateExists && deploymentExists) return "restore";
  if (stateExists) {
    throw new Error("本地 Anvil 状态文件存在，但部署清单缺失；请恢复完整的 .local/anvil 目录或执行 --reset-chain");
  }
  throw new Error("本地 Anvil 部署清单存在，但状态文件缺失；请恢复完整的 .local/anvil 目录或执行 --reset-chain");
}

function buildAnvilArguments({ host, port, chainId, statePath }) {
  return [
    "--host", host,
    "--port", String(port),
    "--chain-id", String(chainId),
    "--state", statePath,
    "--state-interval", "1",
    "--preserve-historical-states",
  ];
}

function parseLocalDeployment(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("本地 Anvil 部署清单不是有效 JSON；请恢复该文件或执行 --reset-chain");
  }
  const parsed = SupportedLocalDeploymentSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("本地 Anvil 部署清单无效或版本不受支持；请恢复该文件或执行 --reset-chain");
  }
  return parsed.data;
}

/**
 * 恢复不能只相信本地 JSON：RPC 链、两个地址的代码、Token 精度与 Escrow 的绑定关系
 * 都必须相互印证。这里把 RPC 调用作为参数注入，让所有拒绝路径可在不启动真实链时测试。
 */
async function validateLocalDeployment(deployment, callRpc) {
  const parsed = SupportedLocalDeploymentSchema.parse(deployment);
  const chainId = await callRpc("eth_chainId", []);
  if (chainId !== "0x7a69") throw new Error(`本地链 Chain ID 为 ${String(chainId)}，预期 31337`);

  const paymentTokenCode = await callRpc("eth_getCode", [parsed.paymentTokenAddress, "latest"]);
  if (!hasContractCode(paymentTokenCode)) throw new Error(`测试 USDC 合约代码不存在：${parsed.paymentTokenAddress}`);
  const escrowCode = await callRpc("eth_getCode", [parsed.escrowAddress, "latest"]);
  if (!hasContractCode(escrowCode)) throw new Error(`Escrow 合约代码不存在：${parsed.escrowAddress}`);

  const paymentTokenResult = await callRpc("eth_call", [{ to: parsed.escrowAddress, data: "0x3013ce29" }, "latest"]);
  const boundPaymentToken = decodeAddressResult(paymentTokenResult, "Escrow paymentToken() 返回值");
  if (boundPaymentToken !== parsed.paymentTokenAddress) {
    throw new Error(`Escrow 绑定的 USDC 地址与部署清单不一致：${boundPaymentToken}`);
  }

  const decimalsResult = await callRpc("eth_call", [{ to: parsed.paymentTokenAddress, data: "0x313ce567" }, "latest"]);
  const decimals = decodeUnsignedIntegerResult(decimalsResult, "USDC decimals() 返回值");
  if (decimals !== 6n) throw new Error(`测试 USDC 精度为 ${decimals}，预期 6`);

  if (parsed.version === 1) return;
  const ydTokenCode = await callRpc("eth_getCode", [parsed.ydTokenAddress, "latest"]);
  if (!hasContractCode(ydTokenCode)) throw new Error(`测试 YD 合约代码不存在：${parsed.ydTokenAddress}`);
  const daoCode = await callRpc("eth_getCode", [parsed.arbitrationDaoAddress, "latest"]);
  if (!hasContractCode(daoCode)) throw new Error(`DAO 质押合约代码不存在：${parsed.arbitrationDaoAddress}`);
  const boundYdResult = await callRpc("eth_call", [{ to: parsed.arbitrationDaoAddress, data: "0xb9c5c022" }, "latest"]);
  const boundYdToken = decodeAddressResult(boundYdResult, "ArbitrationDAO ydToken() 返回值");
  if (boundYdToken !== parsed.ydTokenAddress) throw new Error(`DAO 绑定的 YD 地址与部署清单不一致：${boundYdToken}`);
  const minimumStakeResult = await callRpc("eth_call", [{ to: parsed.arbitrationDaoAddress, data: "0xec5ffac2" }, "latest"]);
  const minimumStake = decodeUnsignedIntegerResult(minimumStakeResult, "ArbitrationDAO minimumStake() 返回值");
  if (minimumStake.toString() !== parsed.daoMinimumStakeMinor) throw new Error("DAO 最低质押额与部署清单不一致");
  const ydDecimalsResult = await callRpc("eth_call", [{ to: parsed.ydTokenAddress, data: "0x313ce567" }, "latest"]);
  const ydDecimals = decodeUnsignedIntegerResult(ydDecimalsResult, "YD decimals() 返回值");
  if (ydDecimals !== 18n) throw new Error(`测试 YD 精度为 ${ydDecimals}，预期 18`);
}

function hasContractCode(value) {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) && !/^0x0*$/.test(value);
}

function decodeAddressResult(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${label}格式无效`);
  }
  return `0x${value.slice(-40)}`.toLowerCase();
}

function decodeUnsignedIntegerResult(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) {
    throw new Error(`${label}格式无效`);
  }
  return BigInt(value);
}

async function waitForStateSnapshot(statePath, minimumModifiedAt) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const metadata = await stat(statePath);
      if (metadata.isFile() && metadata.size > 0 && metadata.mtimeMs >= minimumModifiedAt) return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Anvil 未在部署完成后写入持久化状态，已停止启动且不会生成部署清单");
}

async function writeJsonAtomically(targetPath, value) {
  const temporaryPath = `${targetPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, targetPath);
}

async function fileExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function parseLocalMvpCommand(arguments_) {
  if (arguments_.length === 0) return "start";
  if (arguments_.length === 1 && arguments_[0] === "--reset-chain") return "reset-chain";
  throw new Error(`未知参数：${arguments_.join(" ")}；仅支持 --reset-chain`);
}

async function resetLocalChainState() {
  if (await portOpen(PORTS.anvil)) {
    throw new Error(`${URLS.anvil} 仍在运行；请先正常关闭本地 MVP，再重置持久化链`);
  }
  await rm(LOCAL_CHAIN_DIRECTORY, { recursive: true, force: true });
  console.log(`已重置 AICP 本地链状态：${LOCAL_CHAIN_DIRECTORY}`);
  console.log("下次启动会重新部署测试 USDC 与 Escrow；PostgreSQL 业务数据不会自动删除。");
}

/**
 * 首次创建本地链时部署一对测试 USDC 与 Escrow，并只给 Anvil 默认账户铸币。
 * 测试 Token 的 mint 权限绝不能出现在公共测试网/生产部署路径；正式环境必须通过
 * ESCROW_PAYMENT_TOKEN_ADDRESS 注入官方 USDC，且不会调用本函数。
 */
async function deployLocalMoneyContracts(existingPaymentTokenAddress) {
  const paymentTokenAddress = existingPaymentTokenAddress
    ?? await deployContract("test/TestUSDC.sol:TestUSDC", []);
  const escrowAddress = await deployContract("src/Escrow.sol:Escrow", [
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    paymentTokenAddress,
  ]);
  const ydTokenAddress = await deployContract("test/TestYD.sol:TestYD", []);
  const daoMinimumStakeMinor = LOCAL_DAO_MINIMUM_STAKE_MINOR;
  const arbitrationDaoAddress = await deployContract("src/ArbitrationDAO.sol:ArbitrationDAO", [
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    ANVIL_ACCOUNT,
    ydTokenAddress,
    daoMinimumStakeMinor,
    String(7 * 24 * 60 * 60),
  ]);
  if (existingPaymentTokenAddress === undefined) {
    await capture("cast", [
      "send", paymentTokenAddress, "mint(address,uint256)", ANVIL_ACCOUNT, "100000000000",
      "--rpc-url", URLS.anvil, "--private-key", ANVIL_PRIVATE_KEY,
    ], path.join(ROOT, "contracts/escrow"));
  }
  await capture("cast", [
    "send", ydTokenAddress, "mint(address,uint256)", ANVIL_ACCOUNT, "10000000000000000000000",
    "--rpc-url", URLS.anvil, "--private-key", ANVIL_PRIVATE_KEY,
  ], path.join(ROOT, "contracts/escrow"));
  return { escrowAddress, paymentTokenAddress, ydTokenAddress, arbitrationDaoAddress, daoMinimumStakeMinor };
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
      // 新版案件显式启用后才运行推进器；本地回调仍须独立的 VRF 测试协调器，不会由
      // 启动脚本伪造随机数。只为真实广播交易补确认区块，不重置链或重建既有部署。
      if (process.env.ARBITRATION_CASES_CONTRACT_ADDRESS) {
        const result = await runInternalWorker("/api/internal/workers/dao-cases");
        const parsed = z.object({ submitted: z.number().int().nonnegative() }).parse(result);
        if (parsed.submitted > 0) await mineLocalConfirmationBlocks();
      }
    } catch {
      // 服务刚重载或链短暂不可用时保留 outbox 的重试语义；不输出响应和内部 token。
      if (!shuttingDown) console.error("本地结算自动推进失败，将在下一轮重试");
    }
    // 发奖单独隔离失败，不因奖励池/收款失败跳过原有任务结算与仲裁推进。
    if (localRewardEnabled) {
      try {
        const result = await runInternalWorker("/api/internal/workers/dao-rewards");
        if (result.status === "submitted" || result.status === "confirming") {
          const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).safeParse(result.txHash);
          // 广播响应丢失仍可能已经上链；必须看到真实回执再补确认，不能只凭“待确认”挖块。
          if (hash.success) {
            const receipt = await rpc("eth_getTransactionReceipt", [hash.data]);
            if (z.object({ blockNumber: z.string().regex(/^0x[0-9a-fA-F]+$/) }).safeParse(receipt).success) await mineLocalConfirmationBlocks();
          }
        }
      } catch { /* 下轮恢复同一份持久化签名；不记录可能含凭据的异常对象。 */ }
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

/** 奖励独立启用不依赖新仲裁开关；同时必须显式提供 Gas operator，避免只读目录触发付款。 */
function isLocalRewardWorkerEnabled(env) {
  return Boolean((env.DAO_REWARD_CASE_ADDRESS || env.ARBITRATION_CASES_CONTRACT_ADDRESS)?.trim()
    && env.DAO_REWARD_OPERATOR_ADDRESS?.trim());
}

function required(record, name) { const value = record[name]; if (typeof value !== "string" || value === "") throw new Error(`${name} is missing from agents/paper-writing/.env`); return value; }
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

async function terminateManagedProcesses(managedProcesses, gracefulTimeoutMs = 10_000) {
  const reversed = [...managedProcesses].reverse();
  for (const { child } of reversed) {
    if (!child.killed) child.kill("SIGTERM");
  }

  // Anvil 只会在正常退出流程完成后保证最终状态已经 dump 到磁盘。等待全部 exit 事件既
  // 保护链状态，也避免 PostgreSQL/Next.js 子进程被父进程突然截断；超时才强制终止。
  const exitedGracefully = await settleWithin(reversed.map(({ exit }) => exit), gracefulTimeoutMs);
  if (exitedGracefully) return;

  for (const { child } of reversed) child.kill("SIGKILL");
  await settleWithin(reversed.map(({ exit }) => exit), 2_000);
}

async function settleWithin(promises, timeoutMs) {
  let timeout;
  const timedOut = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
  });
  const settled = Promise.allSettled(promises).then(() => true);
  const result = await Promise.race([settled, timedOut]);
  clearTimeout(timeout);
  return result;
}

async function shutdown(code) {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shuttingDown = true;
  shutdownPromise = (async () => {
    await terminateManagedProcesses(children);
    process.exit(code);
  })();
  return shutdownPromise;
}

/** YD 固定 18 位精度；日志也使用整数运算，避免浮点舍入显示成与链上不同的门槛。 */
function formatLocalYd(minor) {
  const amount = BigInt(minor);
  const whole = amount / 10n ** 18n;
  const fraction = (amount % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

export {
  LOCAL_DAO_MINIMUM_STAKE_MINOR,
  isLocalRewardWorkerEnabled,
  formatLocalYd,
  advanceLocalSettlementOnce,
  assertPortsAvailable,
  buildAnvilArguments,
  isReadyWebHtml,
  parseLocalDeployment,
  parseLocalMvpCommand,
  resolveLocalChainMode,
  terminateManagedProcesses,
  validateLocalDeployment,
  waitForService,
};
