#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "../web/apps/server/node_modules/pg/lib/index.js";
import {
	LOCAL_DATABASE_URL,
	LOCAL_INTERNAL_TOKEN,
} from "./local-runtime-config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const TSX = path.join(
	ROOT,
	"agents/product-workflow/node_modules/tsx/dist/cli.mjs",
);
const SDK_TSC = path.join(
	ROOT,
	"agents/agent-sdk/node_modules/typescript/bin/tsc",
);
const NEXT_WEB = path.join(
	ROOT,
	"web/apps/web/node_modules/next/dist/bin/next",
);
const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const INTERNAL_TOKEN =
	process.env.DISPATCH_INTERNAL_TOKEN ?? LOCAL_INTERNAL_TOKEN;
const PORTS = Object.freeze({
	workflow: readPort("AICP_WORKFLOW_AGENT_PORT", 9202),
	presentation: readPort("AICP_PRESENTATION_AGENT_PORT", 9302),
	browser: readPort("AICP_BROWSER_AGENT_PORT", 9304),
	marketplaceApi: readPort("AICP_MARKETPLACE_API_PORT", 3100),
	dispatch: readPort("AICP_DISPATCH_PORT", 3200),
	web: readPort("AICP_WEB_PORT", 3011),
});
const URLS = Object.freeze({
	workflow: `http://127.0.0.1:${PORTS.workflow}`,
	presentation: `http://127.0.0.1:${PORTS.presentation}`,
	browser: `http://127.0.0.1:${PORTS.browser}`,
	marketplaceApi: `http://127.0.0.1:${PORTS.marketplaceApi}`,
	dispatch: `http://127.0.0.1:${PORTS.dispatch}`,
	web: `http://127.0.0.1:${PORTS.web}`,
});

// 界面开发仍必须启动同一套 API 和 Sepolia 配置；仅省略任务派发与链上 worker。
const uiOnly = process.argv.includes("--ui");
const children = [];
let shuttingDown = false;
let startupComplete = false;
let shutdownPromise;

await main().catch(async (error) => {
	console.error(
		error instanceof Error ? error.message : "Sepolia MVP 启动失败",
	);
	await shutdown(1);
});

async function main() {
	assertSupportedNodeVersion();
	assertLoopbackUrl(DATABASE_URL, "DATABASE_URL");
	await assertPortsAvailable();

	const environment = parseEnv(
		await readFile(path.join(ROOT, ".local/sepolia.env"), "utf8"),
	);
	if (uiOnly) {
		await startUiDevelopment(environment);
		return;
	}
	const manifest = JSON.parse(
		await readFile(path.join(ROOT, ".local/sepolia-wallets.json"), "utf8"),
	);
	const password = readKeychainPassword(manifest);
	validateWalletBindings(environment, manifest);
	const platformAgentWallet = platformAdminAddress(environment, manifest);
	await validateSepoliaDeployment(environment);
	await validateDatabaseVersion();

	const paperEnvironment = parseEnv(
		await readFile(path.join(ROOT, "agents/paper-writing/.env"), "utf8"),
	);
	const openAIKey = required(paperEnvironment, "OPENAI_API_KEY");
	// 自动准入仍独立使用 DeepSeek。工作流模型即使切到 OpenAI，也不能误把 OpenAI
	// 密钥传给只接受 OpenAI-compatible DeepSeek 配置的准入评测器。
	const deepSeekApiKey = required(paperEnvironment, "DEEPSEEK_API_KEY");
	const agentSecret = required(paperEnvironment, "WORKFLOW_AGENT_SECRET");
	const modelEnvironment = workflowModelEnvironment(paperEnvironment);
	if (agentSecret.length < 16)
		throw new Error("WORKFLOW_AGENT_SECRET 长度不足");

	// Sepolia 演示仍通过本机 Agent 服务执行任务，因此目录端点必须在每次启动时与当前
	// 端口配置幂等同步。同步只写 PostgreSQL，不部署合约，也不会广播链上交易。
	await syncLocalAgentDirectory(platformAgentWallet);

	const workflow = start(
		"Product Workflow Agent",
		NODE,
		[TSX, "watch", "src/index.ts"],
		{
			cwd: path.join(ROOT, "agents/product-workflow"),
			env: {
				...modelEnvironment,
				WORKFLOW_AGENT_SECRET: agentSecret,
				WORKFLOW_AGENT_HOST: "127.0.0.1",
				WORKFLOW_AGENT_PORT: String(PORTS.workflow),
				DATABASE_URL,
			},
		},
	);
	await waitForService(
		workflow,
		"Product Workflow Agent",
		`${URLS.workflow}/livez`,
	);

	await startBrowserResearchAgent({
		agentSecret,
		deepSeekApiKey,
		deepSeekBaseUrl:
			paperEnvironment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
		deepSeekModel: paperEnvironment.DEEPSEEK_MODEL ?? "deepseek-chat",
	});
	await startPresentationAgent({
		agentSecret,
		deepSeekApiKey,
		deepSeekBaseUrl: paperEnvironment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
		deepSeekModel: paperEnvironment.DEEPSEEK_MODEL ?? "deepseek-chat",
	});

	const chainEnvironment = {
		...environment,
		DATABASE_URL,
		DISPATCH_ENGINE_URL: URLS.dispatch,
		DISPATCH_INTERNAL_TOKEN: INTERNAL_TOKEN,
		ETHEREUM_RPC_URL: environment.SEPOLIA_RPC_URL,
		SIWE_EXPECTED_DOMAIN: `127.0.0.1:${PORTS.web}`,
		SIWE_EXPECTED_URI: URLS.web,
		SIWE_EXPECTED_CHAIN_ID: "11155111",
		DAO_REWARD_CASE_ADDRESS: environment.ARBITRATION_CASES_CONTRACT_ADDRESS,
		YD_TOKEN_ADDRESS: environment.ARBITRATION_DAO_YD_TOKEN_ADDRESS,
		YD_TOKEN_CHAIN_ID: "11155111",
		YD_TOKEN_DECIMALS: "18",
		ESCROW_OPERATOR_KEYSTORE_PASSWORD: password,
		ARBITRATION_CASE_OPERATOR_KEYSTORE_PASSWORD: password,
		DAO_REWARD_OPERATOR_KEYSTORE_PASSWORD: password,
		DAO_REWARD_AWARD_OPERATOR_KEYSTORE_PASSWORD: password,
		// 本机 workflow agent 使用 loopback HTTP。该开关只放宽服务端连接探测边界；
		// Web 单独关闭本地链模式，因此不会出现 Anvil 挖块或测试币交互。
		AICP_LOCAL_DEMO_MODE: "true",
		WORKFLOW_AGENT_SECRET: agentSecret,
		WORKFLOW_PLANNER_URL: URLS.workflow,
	};
	const marketplaceApi = start(
		"Marketplace API",
		NODE,
		[TSX, "src/server.ts"],
		{
			cwd: path.join(ROOT, "web/apps/server"),
			env: {
				...chainEnvironment,
				HOST: "127.0.0.1",
				PORT: String(PORTS.marketplaceApi),
			},
		},
	);
	await waitForService(
		marketplaceApi,
		"Marketplace API",
		`${URLS.marketplaceApi}/api/health`,
	);

	await startDispatchEngine({
		agentSecret,
		deepSeekApiKey,
		deepSeekBaseUrl:
			paperEnvironment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
		openAIKey,
		admissionEnabled: true,
	});

	await startWeb(environment, agentSecret);

	startupComplete = true;
	void runChainWorkers();
	console.log(`AICP Sepolia 完整闭环已启动：${URLS.web}`);
	console.log("链 ID：11155111；交易确认由 Sepolia 自然出块推进");
	process.on("SIGINT", () => void shutdown(0));
	process.on("SIGTERM", () => void shutdown(0));
	await new Promise(() => undefined);
}

/**
 * 日常 UI 开发与完整演示复用前端启动函数，避免手动 next dev 遗漏 API、RPC 和合约。
 * 独立 distDir 防止生产 build 清理正在使用的开发资源，导致刷新后无法水合或点击。
 */
async function startWeb(environment, agentSecret) {
	const web = start(
		"Web",
		NODE,
		[NEXT_WEB, "dev", "--hostname", "127.0.0.1", "--port", String(PORTS.web)],
		{
			cwd: path.join(ROOT, "web/apps/web"),
			env: {
				AICP_NEXT_DIST_DIR: "dev-dist/sepolia-mvp",
				NEXT_PUBLIC_SERVER_URL: URLS.web,
				NEXT_PUBLIC_MARKETPLACE_API_URL: `${URLS.marketplaceApi}/api`,
				NEXT_PUBLIC_ETHEREUM_RPC_URL: environment.SEPOLIA_RPC_URL,
				NEXT_PUBLIC_ESCROW_CONTRACT_ADDRESS:
					environment.ESCROW_CONTRACT_ADDRESS,
				NEXT_PUBLIC_ESCROW_PAYMENT_TOKEN_ADDRESS:
					environment.ESCROW_PAYMENT_TOKEN_ADDRESS,
				NEXT_PUBLIC_ARBITRATION_DAO_ADDRESS:
					environment.ARBITRATION_DAO_CONTRACT_ADDRESS,
				NEXT_PUBLIC_ARBITRATION_DAO_YD_TOKEN_ADDRESS:
					environment.ARBITRATION_DAO_YD_TOKEN_ADDRESS,
				NEXT_PUBLIC_ARBITRATION_DAO_MINIMUM_STAKE_MINOR:
					environment.ARBITRATION_DAO_MINIMUM_STAKE_MINOR,
				NEXT_PUBLIC_AICP_LOCAL_DEMO_MODE: "false",
				AICP_LOCAL_DEMO_MODE: "false",
				WORKFLOW_AGENT_URL: `${URLS.workflow}/v1/workflow/execute`,
				WORKFLOW_AGENT_SECRET: agentSecret,
			},
		},
	);
	await waitForService(web, "Web", URLS.web, false);
}

/**
 * 界面模式不解密 operator，也不运行链上 worker；但会启动工作流规划、Hono API 与
 * Dispatch Engine，让确认后的节点真正生成候选。数据库缺失时明确失败，不创建或重置。
 */
async function startUiDevelopment(environment) {
	await validateDatabaseVersion();
	const manifest = JSON.parse(
		await readFile(path.join(ROOT, ".local/sepolia-wallets.json"), "utf8"),
	);
	const platformAgentWallet = platformAdminAddress(environment, manifest);
	const paperEnvironment = parseEnv(
		await readFile(path.join(ROOT, "agents/paper-writing/.env"), "utf8"),
	);
	const agentSecret = required(paperEnvironment, "WORKFLOW_AGENT_SECRET");
	const openAIKey = required(paperEnvironment, "OPENAI_API_KEY");
	const deepSeekApiKey = required(paperEnvironment, "DEEPSEEK_API_KEY");
	const modelEnvironment = workflowModelEnvironment(paperEnvironment);
	await syncLocalAgentDirectory(platformAgentWallet);
	const workflow = start(
		"Product Workflow Agent",
		NODE,
		[TSX, "watch", "src/index.ts"],
		{
			cwd: path.join(ROOT, "agents/product-workflow"),
			env: {
				DATABASE_URL,
				...modelEnvironment,
				WORKFLOW_AGENT_SECRET: agentSecret,
				WORKFLOW_AGENT_HOST: "127.0.0.1",
				WORKFLOW_AGENT_PORT: String(PORTS.workflow),
			},
		},
	);
	await waitForService(
		workflow,
		"Product Workflow Agent",
		`${URLS.workflow}/livez`,
	);
	await startBrowserResearchAgent({
		agentSecret,
		deepSeekApiKey,
		deepSeekBaseUrl:
			paperEnvironment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
		deepSeekModel: paperEnvironment.DEEPSEEK_MODEL ?? "deepseek-chat",
	});
	await startPresentationAgent({
		agentSecret,
		deepSeekApiKey,
		deepSeekBaseUrl: paperEnvironment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
		deepSeekModel: paperEnvironment.DEEPSEEK_MODEL ?? "deepseek-chat",
	});
	const api = start("Marketplace API", NODE, [TSX, "src/server.ts"], {
		cwd: path.join(ROOT, "web/apps/server"),
		env: {
			...environment,
			DATABASE_URL,
			HOST: "127.0.0.1",
			PORT: String(PORTS.marketplaceApi),
			ETHEREUM_RPC_URL: environment.SEPOLIA_RPC_URL,
			SIWE_EXPECTED_DOMAIN: `127.0.0.1:${PORTS.web}`,
			SIWE_EXPECTED_URI: URLS.web,
			SIWE_EXPECTED_CHAIN_ID: "11155111",
			WORKFLOW_AGENT_SECRET: agentSecret,
			WORKFLOW_PLANNER_URL: URLS.workflow,
			DISPATCH_ENGINE_URL: URLS.dispatch,
			DISPATCH_INTERNAL_TOKEN: INTERNAL_TOKEN,
		},
	});
	await waitForService(
		api,
		"Marketplace API",
		`${URLS.marketplaceApi}/api/health`,
	);
	const response = await fetch(`${URLS.marketplaceApi}/api/auth/nonce`, {
		signal: AbortSignal.timeout(5000),
	});
	const challenge = await response.json();
	if (
		!response.ok ||
		challenge.chainId !== 11155111 ||
		challenge.uri !== URLS.web ||
		challenge.domain !== `127.0.0.1:${PORTS.web}`
	) {
		throw new Error("登录 API 的 Sepolia 网络或站点配置不一致");
	}
	await startDispatchEngine({
		agentSecret,
		deepSeekBaseUrl:
			paperEnvironment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
		openAIKey,
		// UI 模式需要候选匹配与手动选人，但不应顺带推进新 Agent 的模型准入轮次。
		admissionEnabled: false,
	});
	await startWeb(environment, agentSecret);
	startupComplete = true;
	console.log(
		`界面、钱包登录与候选匹配已就绪：${URLS.web}；链上 worker 未启动`,
	);
	process.on("SIGINT", () => void shutdown(0));
	process.on("SIGTERM", () => void shutdown(0));
	await new Promise(() => undefined);
}

/** 同步本机可执行 Agent 的稳定目录；幂等更新端点和报价，不创建链上身份或资金事实。 */
async function syncLocalAgentDirectory(platformAgentWallet) {
	await runOnce("Agent SDK", NODE, [SDK_TSC, "-p", "tsconfig.build.json"], {
		cwd: path.join(ROOT, "agents/agent-sdk"),
		env: {},
	});
	await runOnce("产品 Agent 目录", NODE, [TSX, "src/local-bootstrap.ts"], {
		cwd: path.join(ROOT, "agents/product-workflow"),
		env: {
			AICP_LOCAL_DEMO_MODE: "true",
			DATABASE_URL,
			WORKFLOW_AGENT_PUBLIC_URL: URLS.workflow,
		},
	});
	await runOnce("网页调研助手目录", NODE, [TSX, "src/local-bootstrap.ts"], {
		cwd: path.join(ROOT, "agents/browser-research"),
		env: {
			AICP_LOCAL_DEMO_MODE: "true",
			AICP_PLATFORM_AGENT_OWNER_ADDRESS: platformAgentWallet,
			DATABASE_URL,
			BROWSER_AGENT_PUBLIC_URL: URLS.browser,
		},
	});
	await runOnce("演示文稿 Agent 目录", NODE, [TSX, "src/local-bootstrap.ts"], {
		cwd: path.join(ROOT, "agents/presentation-generation"),
		env: {
			AICP_LOCAL_DEMO_MODE: "true",
			AICP_PLATFORM_AGENT_OWNER_ADDRESS: platformAgentWallet,
			DATABASE_URL,
			PRESENTATION_AGENT_PUBLIC_URL: URLS.presentation,
		},
	});
}

/**
 * Stagehand 独立管理 Chromium；不启用源码 watch，避免为大依赖树持续保留文件句柄。
 * 健康探测和正式执行必须访问同一端点，因此 UI 完整体验也必须启动该服务。
 */
async function startBrowserResearchAgent({
	agentSecret,
	deepSeekApiKey,
	deepSeekBaseUrl,
	deepSeekModel,
}) {
	const browserAgent = start("网页调研助手", NODE, [TSX, "src/index.ts"], {
		cwd: path.join(ROOT, "agents/browser-research"),
		env: {
			DEEPSEEK_API_KEY: deepSeekApiKey,
			DEEPSEEK_BASE_URL: deepSeekBaseUrl,
			DEEPSEEK_MODEL: deepSeekModel,
			AGENT_HOST: "127.0.0.1",
			AGENT_PORT: String(PORTS.browser),
			AGENT_PUBLIC_BASE_URL: URLS.browser,
			AGENT_API_KEY: agentSecret,
			AGENT_ARTIFACT_DIR: path.join(ROOT, ".local/artifacts/browser-research"),
			AGENT_RESPONSE_CACHE_DIR: path.join(
				ROOT,
				".local/responses/browser-research",
			),
		},
	});
	await waitForService(
		browserAgent,
		"网页调研助手",
		`${URLS.browser}/healthz`,
		true,
		{ authorization: `Bearer ${agentSecret}` },
	);
}

/** 演示文稿服务在同一端点按工作流输出契约执行策划、制作或交付质检。 */
async function startPresentationAgent({
	agentSecret,
	deepSeekApiKey,
	deepSeekBaseUrl,
	deepSeekModel,
}) {
	const agent = start("演示文稿 Agent", NODE, [TSX, "src/index.ts"], {
		cwd: path.join(ROOT, "agents/presentation-generation"),
		env: {
			DEEPSEEK_API_KEY: deepSeekApiKey,
			DEEPSEEK_BASE_URL: deepSeekBaseUrl,
			DEEPSEEK_MODEL: deepSeekModel,
			AGENT_HOST: "127.0.0.1",
			AGENT_PORT: String(PORTS.presentation),
			AGENT_PUBLIC_BASE_URL: URLS.presentation,
			AGENT_API_KEY: agentSecret,
			AGENT_ARTIFACT_DIR: path.join(ROOT, ".local/artifacts/presentation"),
			AGENT_RESPONSE_CACHE_DIR: path.join(ROOT, ".local/responses/presentation"),
		},
	});
	await waitForService(
		agent,
		"演示文稿 Agent",
		`${URLS.presentation}/healthz`,
		true,
		{ authorization: `Bearer ${agentSecret}` },
	);
}

/**
 * 两种 Sepolia 启动方式共享同一个分发引擎装配。UI 模式只关闭自动准入；工作流节点
 * 的首次匹配 worker 必须保留，否则“确认并推荐 Agent”会生成正式 DAG 却永久没有候选。
 * 此函数不启动任何链上 worker，也不会持有 operator 私钥或广播交易。
 */
async function startDispatchEngine({
	agentSecret,
	deepSeekApiKey,
	deepSeekBaseUrl,
	openAIKey,
	admissionEnabled,
}) {
	const dispatch = start("Dispatch Engine", "go", ["run", "./cmd/server"], {
		cwd: path.join(ROOT, "services/dispatch-engine"),
		env: {
			DATABASE_URL,
			DISPATCH_INTERNAL_TOKEN: INTERNAL_TOKEN,
			MARKETPLACE_API_URL: URLS.marketplaceApi,
			DISPATCH_HTTP_ADDRESS: `127.0.0.1:${PORTS.dispatch}`,
			DISPATCH_PUBLIC_URL: URLS.dispatch,
			DISPATCH_QUEUE_MODE: "local",
			LOCAL_AGENT_SECRET: agentSecret,
			...(deepSeekApiKey === undefined
				? {}
				: { DEEPSEEK_API_KEY: deepSeekApiKey }),
			DEEPSEEK_BASE_URL: deepSeekBaseUrl,
			// V1 只在分发引擎内调用 Embeddings API，密钥不传给 Web 或 Agent 进程。
			MATCHING_SEMANTIC_ENABLED: "true",
			OPENAI_API_KEY: openAIKey,
			AGENT_ADMISSION_ENABLED: admissionEnabled ? "true" : "false",
			AGENT_ADMISSION_EVALUATOR_MODEL:
				process.env.AGENT_ADMISSION_EVALUATOR_MODEL ?? "deepseek-chat",
			AGENT_ADMISSION_ENGINE: process.env.AGENT_ADMISSION_ENGINE ?? "postgres",
			TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233",
			TEMPORAL_NAMESPACE: process.env.TEMPORAL_NAMESPACE ?? "default",
			TEMPORAL_ADMISSION_TASK_QUEUE:
				process.env.TEMPORAL_ADMISSION_TASK_QUEUE ?? "aicp-agent-admission-v1",
		},
	});
	await waitForService(dispatch, "Dispatch Engine", `${URLS.dispatch}/health`);
}

async function validateSepoliaDeployment(environment) {
	const chainId = await rpc(environment.SEPOLIA_RPC_URL, "eth_chainId", []);
	if (chainId !== "0xaa36a7") throw new Error("SEPOLIA_CHAIN_ID_MISMATCH");
	for (const key of [
		"ARBITRATION_DAO_YD_TOKEN_ADDRESS",
		"ESCROW_PAYMENT_TOKEN_ADDRESS",
		"ARBITRATION_DAO_CONTRACT_ADDRESS",
		"ESCROW_CONTRACT_ADDRESS",
		"ARBITRATION_CASES_CONTRACT_ADDRESS",
		"CHAINLINK_VRF_COORDINATOR",
	]) {
		const code = await rpc(environment.SEPOLIA_RPC_URL, "eth_getCode", [
			required(environment, key),
			"latest",
		]);
		if (
			typeof code !== "string" ||
			!/^0x[0-9a-f]+$/i.test(code) ||
			/^0x0*$/i.test(code)
		) {
			throw new Error(`${key}_CODE_MISSING`);
		}
	}
	try {
		const value = await rpc(environment.SEPOLIA_RPC_URL, "eth_call", [
			{
				to: required(environment, "ARBITRATION_CASES_CONTRACT_ADDRESS"),
				data: "0x06a4df7a",
			},
			"latest",
		]);
		return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
	} catch {
		// 历史案件合约没有 recoveryWindow()；旧部署继续允许 v45，只读兼容不代表支持恢复。
		return false;
	}
}

async function validateDatabaseVersion() {
	const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
	try {
		const result = await pool.query(
			"SELECT version::text,dirty FROM business_service_schema_migrations",
		);
		const row = result.rows[0];

		// 以已提交迁移文件为唯一版本源，避免新增迁移后启动器仍硬编码旧版本而拒绝启动。
		const migrations = await readdir(
			path.join(ROOT, "services/business-service/migrations"),
		);
		const versions = migrations
			.map((name) => /^(\d+)_.*\.up\.sql$/.exec(name)?.[1])
			.filter(Boolean)
			.map(Number);
		const expected = Math.max(...versions);
		if (
			!Number.isFinite(expected) ||
			Number(row?.version) !== expected ||
			row.dirty !== false
		) {
			throw new Error(
				`数据库迁移未就绪：需要版本 ${expected}，当前 ${row?.version ?? "未知"}，dirty=${row?.dirty}。请先核对迁移；启动器不会自动修改数据库。`,
			);
		}
	} finally {
		await pool.end();
	}
}

function validateWalletBindings(environment, manifest) {
	const bindings = [
		[
			"escrow_operator",
			"ESCROW_OPERATOR_ADDRESS",
			"ESCROW_OPERATOR_KEYSTORE_PATH",
		],
		[
			"case_operator",
			"ARBITRATION_CASE_OPERATOR_ADDRESS",
			"ARBITRATION_CASE_OPERATOR_KEYSTORE_PATH",
		],
		[
			"reward_operator",
			"DAO_REWARD_OPERATOR_ADDRESS",
			"DAO_REWARD_OPERATOR_KEYSTORE_PATH",
		],
		[
			"reward_award_operator",
			"DAO_REWARD_AWARD_OPERATOR_ADDRESS",
			"DAO_REWARD_AWARD_OPERATOR_KEYSTORE_PATH",
		],
	];
	for (const [role, addressKey, pathKey] of bindings) {
		const wallet = manifest.wallets.find((entry) => entry.role === role);
		if (
			wallet === undefined ||
			wallet.address.toLowerCase() !==
				required(environment, addressKey).toLowerCase() ||
			path.resolve(required(environment, pathKey)) !==
				path.join(ROOT, ".local/sepolia-keystores", wallet.file)
		) {
			throw new Error(`SEPOLIA_${role.toUpperCase()}_BINDING_MISMATCH`);
		}
	}
	if (
		environment.EVM_OPERATOR_MODE !== "encrypted-keystore" ||
		environment.ESCROW_OPERATOR_MODE !== "encrypted-keystore"
	) {
		throw new Error("SEPOLIA_ENCRYPTED_KEYSTORE_REQUIRED");
	}
}

function platformAdminAddress(environment, manifest) {
	const wallet = manifest.wallets.find((entry) => entry.role === "admin");
	if (
		wallet === undefined ||
		!/^0x[0-9a-fA-F]{40}$/.test(wallet.address) ||
		wallet.address.toLowerCase() !==
			required(environment, "DAO_CASE_ADMIN").toLowerCase()
	) {
		// 网页调研助手的目录所有者也是当前本机演示的收款地址。必须和已部署案件合约的
		// 管理员绑定一致，避免清单被替换后把后续测试 USDC 结算到陌生地址。
		throw new Error("SEPOLIA_ADMIN_WALLET_BINDING_MISMATCH");
	}
	return wallet.address;
}

function readKeychainPassword(manifest) {
	const result = spawnSync(
		"/usr/bin/security",
		[
			"find-generic-password",
			"-w",
			"-a",
			manifest.keychainAccount,
			"-s",
			manifest.keychainService,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0 || result.stdout.trim() === "") {
		throw new Error("SEPOLIA_KEYCHAIN_PASSWORD_UNAVAILABLE");
	}
	return result.stdout.trim();
}

async function runChainWorkers() {
	const paths = [
		"/api/internal/workers/escrow-execution",
		"/api/internal/workers/escrow-sync",
		"/api/internal/workers/dao-cases",
		"/api/internal/workers/dao-rewards",
	];
	while (!shuttingDown) {
		for (const pathname of paths) {
			try {
				const response = await fetch(`${URLS.marketplaceApi}${pathname}`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${INTERNAL_TOKEN}`,
						"content-type": "application/json",
					},
					body: "{}",
					signal: AbortSignal.timeout(30_000),
				});
				if (!response.ok) throw new Error("WORKER_RESPONSE_NOT_OK");
				await response.arrayBuffer();
			} catch {
				if (!shuttingDown)
					console.error(`Sepolia worker 暂时失败：${pathname}`);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
}

function start(label, command, arguments_, options) {
	const child = spawn(command, arguments_, {
		cwd: options.cwd,
		env: { ...process.env, ...options.env },
		stdio: "inherit",
	});
	const exit = new Promise((resolve) => {
		child.once("error", (error) => resolve({ error }));
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	const managed = { child, exit };
	children.push(managed);
	void exit.then((outcome) => {
		if (shuttingDown) return;
		const reason =
			"error" in outcome
				? outcome.error.message
				: outcome.signal === null
					? `code ${outcome.code}`
					: `signal ${outcome.signal}`;
		console.error(`${label} 意外退出：${reason}`);
		if (startupComplete) void shutdown(1);
	});
	return managed;
}

async function runOnce(label, command, arguments_, options) {
	const outcome = await new Promise((resolve) => {
		const child = spawn(command, arguments_, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: "inherit",
		});
		child.once("error", (error) => resolve({ error }));
		child.once("exit", (code, signal) => resolve({ code, signal }));
	});
	if ("error" in outcome) {
		throw new Error(`${label} 启动失败：${outcome.error.message}`);
	}
	if (outcome.code !== 0) {
		const reason =
			outcome.signal === null
				? `code ${outcome.code}`
				: `signal ${outcome.signal}`;
		throw new Error(`${label} 执行失败：${reason}`);
	}
}

async function waitForService(
	managed,
	label,
	url,
	expectJson = true,
	headers = undefined,
) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const probe = fetch(url, { headers, signal: AbortSignal.timeout(1_000) })
			.then(async (response) => {
				if (!response.ok) return false;
				if (!expectJson) return true;
				const body = await response.json();
				return body?.status === "ok" || body?.status === "up";
			})
			.catch(() => false);
		const outcome = await Promise.race([
			probe.then((ready) => ({ ready })),
			managed.exit.then((exit) => ({ exit })),
		]);
		if ("exit" in outcome) throw new Error(`${label} 在就绪前退出`);
		if (outcome.ready) return;
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error(`${label} 未在 30 秒内就绪`);
}

async function rpc(url, method, parameters) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: parameters }),
		signal: AbortSignal.timeout(10_000),
	});
	const body = await response.json();
	if (!response.ok || body.error !== undefined)
		throw new Error(`SEPOLIA_RPC_${method}_FAILED`);
	return body.result;
}

function parseEnv(source) {
	const result = {};
	for (const raw of source.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new Error("ENV_FILE_INVALID");
		result[line.slice(0, separator)] = line.slice(separator + 1);
	}
	return result;
}

function required(record, key) {
	const value = record[key]?.trim();
	if (value === undefined || value === "") throw new Error(`${key}_REQUIRED`);
	return value;
}

function assertSupportedNodeVersion() {
	const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
	if (!Number.isInteger(major) || major < 22) {
		throw new Error(
			`Sepolia MVP 需要 Node.js 22；当前为 ${process.versions.node}`,
		);
	}
}

function assertLoopbackUrl(value, name) {
	const host = new URL(value).hostname;
	if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
		throw new Error(`${name} 必须指向 loopback`);
	}
}

function readPort(name, fallback) {
	const raw = process.env[name] ?? String(fallback);
	const value = Number(raw);
	if (
		!/^[0-9]+$/.test(raw) ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 65_535
	) {
		throw new Error(`${name} 必须是有效端口`);
	}
	return value;
}

function portOpen(port) {
	return new Promise((resolve) => {
		const socket = net.createConnection({ host: "127.0.0.1", port });
		socket.setTimeout(300);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("timeout", () => {
			socket.destroy();
			resolve(false);
		});
		socket.once("error", () => resolve(false));
	});
}

async function assertPortsAvailable() {
	for (const [label, port] of Object.entries(PORTS)) {
		if (
			uiOnly &&
			!["web", "marketplaceApi", "workflow", "browser", "dispatch"].includes(
				label,
			)
		)
			continue;
		if (await portOpen(port)) throw new Error(`${label} 端口 ${port} 已被占用`);
	}
}

/**
 * 启动器只负责把统一模型配置传给 Product Workflow Agent。默认继续复用现有 DeepSeek
 * 配置；切换 OpenAI 时设置 provider 即可复用同一份 OPENAI_API_KEY，不改启动代码。
 */
function workflowModelEnvironment(source) {
	const provider =
		process.env.WORKFLOW_MODEL_PROVIDER ??
		source.WORKFLOW_MODEL_PROVIDER ??
		"deepseek";
	if (provider !== "deepseek" && provider !== "openai") {
		throw new Error("WORKFLOW_MODEL_PROVIDER 只支持 deepseek 或 openai");
	}
	const apiKey =
		process.env.WORKFLOW_MODEL_API_KEY ??
		source.WORKFLOW_MODEL_API_KEY ??
		(provider === "deepseek" ? source.DEEPSEEK_API_KEY : source.OPENAI_API_KEY);
	if (apiKey === undefined || apiKey.length === 0) {
		throw new Error(`${provider} 模式缺少 WORKFLOW_MODEL_API_KEY`);
	}
	return {
		WORKFLOW_MODEL_PROVIDER: provider,
		WORKFLOW_MODEL_API_KEY: apiKey,
		WORKFLOW_MODEL_BASE_URL:
			process.env.WORKFLOW_MODEL_BASE_URL ??
			source.WORKFLOW_MODEL_BASE_URL ??
			(provider === "openai"
				? "https://api.openai.com/v1"
				: (source.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com")),
		WORKFLOW_AGENT_MODEL:
			process.env.WORKFLOW_AGENT_MODEL ??
			source.WORKFLOW_AGENT_MODEL ??
			(provider === "openai" ? "gpt-5-mini" : "deepseek-chat"),
	};
}

function shutdown(code) {
	if (shutdownPromise !== undefined) return shutdownPromise;
	shuttingDown = true;
	shutdownPromise = (async () => {
		for (const { child } of children) {
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGTERM");
		}
		await Promise.all(children.map(({ exit }) => exit));
		process.exitCode = code;
	})();
	return shutdownPromise;
}
