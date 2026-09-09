#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "../services/business-api/node_modules/pg/lib/index.js";
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
const NEXT_WEB = path.join(
	ROOT,
	"web/apps/web/node_modules/next/dist/bin/next",
);
const NEXT_BUSINESS = path.join(
	ROOT,
	"services/business-api/node_modules/next/dist/bin/next",
);
const DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL;
const INTERNAL_TOKEN =
	process.env.DISPATCH_INTERNAL_TOKEN ?? LOCAL_INTERNAL_TOKEN;
const PORTS = Object.freeze({
	workflow: readPort("AICP_WORKFLOW_AGENT_PORT", 9202),
	business: readPort("AICP_BUSINESS_API_PORT", 3100),
	dispatch: readPort("AICP_DISPATCH_PORT", 3200),
	web: readPort("AICP_WEB_PORT", 3011),
});
const URLS = Object.freeze({
	workflow: `http://127.0.0.1:${PORTS.workflow}`,
	business: `http://127.0.0.1:${PORTS.business}`,
	dispatch: `http://127.0.0.1:${PORTS.dispatch}`,
	web: `http://127.0.0.1:${PORTS.web}`,
});

const children = [];
let shuttingDown = false;
let startupComplete = false;
let shutdownPromise;

await main().catch(async (error) => {
	console.error(error instanceof Error ? error.message : "Sepolia MVP 启动失败");
	await shutdown(1);
});

async function main() {
	assertSupportedNodeVersion();
	assertLoopbackUrl(DATABASE_URL, "DATABASE_URL");
	await assertPortsAvailable();

	const environment = parseEnv(
		await readFile(path.join(ROOT, ".local/sepolia.env"), "utf8"),
	);
	const manifest = JSON.parse(
		await readFile(path.join(ROOT, ".local/sepolia-wallets.json"), "utf8"),
	);
	const password = readKeychainPassword(manifest);
	validateWalletBindings(environment, manifest);
	const recoveryEnabled = await validateSepoliaDeployment(environment);
	await validateDatabaseVersion(recoveryEnabled);

	const paperEnvironment = parseEnv(
		await readFile(path.join(ROOT, "agents/paper-writing/.env"), "utf8"),
	);
	const apiKey = required(paperEnvironment, "DEEPSEEK_API_KEY");
	const agentSecret = required(paperEnvironment, "WORKFLOW_AGENT_SECRET");
	if (agentSecret.length < 16) throw new Error("WORKFLOW_AGENT_SECRET 长度不足");

	const workflow = start(
		"Product Workflow Agent",
		NODE,
		[TSX, "watch", "src/index.ts"],
		{
			cwd: path.join(ROOT, "agents/product-workflow"),
			env: {
				DEEPSEEK_API_KEY: apiKey,
				DEEPSEEK_BASE_URL:
					paperEnvironment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
				WORKFLOW_AGENT_MODEL:
					process.env.WORKFLOW_AGENT_MODEL ??
					paperEnvironment.WORKFLOW_AGENT_MODEL ??
					"deepseek-chat",
				WORKFLOW_AGENT_SECRET: agentSecret,
				WORKFLOW_AGENT_HOST: "127.0.0.1",
				WORKFLOW_AGENT_PORT: String(PORTS.workflow),
			},
		},
	);
	await waitForService(workflow, "Product Workflow Agent", `${URLS.workflow}/livez`);

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
	};
	const business = start(
		"Business API",
		NODE,
		[
			NEXT_BUSINESS,
			"dev",
			"--hostname",
			"127.0.0.1",
			"--port",
			String(PORTS.business),
		],
		{ cwd: path.join(ROOT, "services/business-api"), env: chainEnvironment },
	);
	await waitForService(business, "Business API", `${URLS.business}/api/health`);

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
			DEEPSEEK_API_KEY: apiKey,
			DEEPSEEK_BASE_URL:
				paperEnvironment.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
			AGENT_ADMISSION_EVALUATOR_MODEL:
				process.env.AGENT_ADMISSION_EVALUATOR_MODEL ?? "deepseek-chat",
		},
	});
	await waitForService(dispatch, "Dispatch Engine", `${URLS.dispatch}/health`);

	const web = start(
		"Web",
		NODE,
		[
			NEXT_WEB,
			"dev",
			"--hostname",
			"127.0.0.1",
			"--port",
			String(PORTS.web),
		],
		{
			cwd: path.join(ROOT, "web/apps/web"),
			env: {
				AICP_NEXT_DIST_DIR: "dev-dist/sepolia-mvp",
				NEXT_PUBLIC_SERVER_URL: URLS.web,
				NEXT_PUBLIC_BUSINESS_API_URL: `${URLS.business}/api`,
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

	startupComplete = true;
	void runChainWorkers();
	console.log(`AICP Sepolia 完整闭环已启动：${URLS.web}`);
	console.log("链 ID：11155111；交易确认由 Sepolia 自然出块推进");
	process.on("SIGINT", () => void shutdown(0));
	process.on("SIGTERM", () => void shutdown(0));
	await new Promise(() => undefined);
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
		if (typeof code !== "string" || !/^0x[0-9a-f]+$/i.test(code) || /^0x0*$/i.test(code)) {
			throw new Error(`${key}_CODE_MISSING`);
		}
	}
	try {
		const value = await rpc(environment.SEPOLIA_RPC_URL, "eth_call", [
			{ to: required(environment, "ARBITRATION_CASES_CONTRACT_ADDRESS"), data: "0x06a4df7a" },
			"latest",
		]);
		return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
	} catch {
		// 历史案件合约没有 recoveryWindow()；旧部署继续允许 v45，只读兼容不代表支持恢复。
		return false;
	}
}

async function validateDatabaseVersion(recoveryEnabled) {
	const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
	try {
		const result = await pool.query(
			"SELECT version::text,dirty FROM business_service_schema_migrations",
		);
		const row = result.rows[0];
		const supportedVersions = recoveryEnabled
			? ["46", "47", "48", "49", "50"]
			: ["45", "46", "47", "48", "49", "50"];
		if (!supportedVersions.includes(row?.version) || row.dirty !== false) {
			throw new Error(
				`BUSINESS_DATABASE_MIGRATION_${recoveryEnabled ? "46_TO_50" : "45_TO_50"}_REQUIRED`,
			);
		}
	} finally {
		await pool.end();
	}
}

function validateWalletBindings(environment, manifest) {
	const bindings = [
		["escrow_operator", "ESCROW_OPERATOR_ADDRESS", "ESCROW_OPERATOR_KEYSTORE_PATH"],
		["case_operator", "ARBITRATION_CASE_OPERATOR_ADDRESS", "ARBITRATION_CASE_OPERATOR_KEYSTORE_PATH"],
		["reward_operator", "DAO_REWARD_OPERATOR_ADDRESS", "DAO_REWARD_OPERATOR_KEYSTORE_PATH"],
		["reward_award_operator", "DAO_REWARD_AWARD_OPERATOR_ADDRESS", "DAO_REWARD_AWARD_OPERATOR_KEYSTORE_PATH"],
	];
	for (const [role, addressKey, pathKey] of bindings) {
		const wallet = manifest.wallets.find((entry) => entry.role === role);
		if (
			wallet === undefined ||
			wallet.address.toLowerCase() !== required(environment, addressKey).toLowerCase() ||
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
				const response = await fetch(`${URLS.business}${pathname}`, {
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
				if (!shuttingDown) console.error(`Sepolia worker 暂时失败：${pathname}`);
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

async function waitForService(managed, label, url, expectJson = true) {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const probe = fetch(url, { signal: AbortSignal.timeout(1_000) })
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
	if (!response.ok || body.error !== undefined) throw new Error(`SEPOLIA_RPC_${method}_FAILED`);
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
		throw new Error(`Sepolia MVP 需要 Node.js 22；当前为 ${process.versions.node}`);
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
	if (!/^[0-9]+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > 65_535) {
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
		if (await portOpen(port)) throw new Error(`${label} 端口 ${port} 已被占用`);
	}
}

function shutdown(code) {
	if (shutdownPromise !== undefined) return shutdownPromise;
	shuttingDown = true;
	shutdownPromise = (async () => {
		for (const { child } of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		}
		await Promise.all(children.map(({ exit }) => exit));
		process.exitCode = code;
	})();
	return shutdownPromise;
}
