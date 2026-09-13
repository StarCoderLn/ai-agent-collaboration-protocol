import { pathToFileURL } from "node:url";

import pg from "pg";
import { z } from "zod";

import { BROWSER_RESEARCH_AGENT } from "./catalog.js";

const WalletAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const EnvironmentSchema = z.object({
	// 当前同步器只服务于数据库和 Agent 都运行在本机的演示闭环。生产部署必须使用
	// 独立的服务发现与密钥管理，不能把 loopback 端点写入远程数据库。
	AICP_LOCAL_DEMO_MODE: z.literal("true"),
	DATABASE_URL: z.url(),
	BROWSER_AGENT_PUBLIC_URL: z.url().default("http://127.0.0.1:9304"),
	AICP_PLATFORM_AGENT_OWNER_ADDRESS: WalletAddressSchema,
	AICP_PLATFORM_AGENT_PAYOUT_ADDRESS: WalletAddressSchema.optional(),
});

type QueryResult = Readonly<{ rowCount: number | null }>;
export interface BrowserCatalogDatabase {
	query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}

/**
 * 将网页调研助手幂等同步到平台正式目录。
 *
 * Agent UUID、用户可见名称、能力、报价和端点全部来自 catalog.ts；数据库只保存当前
 * 运行环境的投影。同步同时写入本机凭证标记和健康检查配置，确保市场里出现的卡片确实
 * 能被 Dispatch 调用，而不是一张无法执行的静态展示卡。
 */
export async function bootstrapBrowserResearchAgent(
	environment: NodeJS.ProcessEnv,
	database: BrowserCatalogDatabase,
): Promise<void> {
	const parsed = EnvironmentSchema.parse(environment);
	assertLoopback(parsed.DATABASE_URL, "DATABASE_URL");
	const publicUrl = normalizedLoopbackUrl(parsed.BROWSER_AGENT_PUBLIC_URL);
	const payoutAddress =
		parsed.AICP_PLATFORM_AGENT_PAYOUT_ADDRESS ??
		parsed.AICP_PLATFORM_AGENT_OWNER_ADDRESS;

	await database.query("BEGIN");
	try {
		// 研究分析是平台既有根分类；幂等补齐只为兼容尚未应用完整分类种子的开发库。
		await database.query(
			`INSERT INTO categories(id,parent_id,name,slug,version)
			 VALUES ($1,NULL,'研究分析','research-analysis',1)
			 ON CONFLICT (id) DO NOTHING`,
			[BROWSER_RESEARCH_AGENT.categoryId],
		);
		await database.query(
			// 网页调研助手实现的是同步 Quick Agent JSON 协议。这里必须显式写 http_json，
			// 否则数据库默认的 aicp_hmac 会让 Dispatch 发送签名头而不是 Bearer Token。
			`INSERT INTO agents(
			   id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
			   pricing_type,price_amount,price_currency,service_endpoint,integration_mode,email,status,
			   estimated_duration_seconds,response_minutes
			 ) VALUES ($1,$2,$3,$4,$5,$6,$7,'fixed',$8,'USDC',$9,'http_json',$10,'active',900,1)
			 ON CONFLICT (id) DO UPDATE SET
			   provider_wallet_address=EXCLUDED.provider_wallet_address,
			   payout_wallet_address=EXCLUDED.payout_wallet_address,
			   name=EXCLUDED.name,category_id=EXCLUDED.category_id,
			   capability_desc=EXCLUDED.capability_desc,tags=EXCLUDED.tags,
			   pricing_type=EXCLUDED.pricing_type,price_amount=EXCLUDED.price_amount,
			   price_currency=EXCLUDED.price_currency,service_endpoint=EXCLUDED.service_endpoint,
			   integration_mode=EXCLUDED.integration_mode,
			   email=EXCLUDED.email,status='active',pause_reason=NULL,
			   estimated_duration_seconds=EXCLUDED.estimated_duration_seconds,
			   response_minutes=EXCLUDED.response_minutes`,
			[
				BROWSER_RESEARCH_AGENT.platformId,
				parsed.AICP_PLATFORM_AGENT_OWNER_ADDRESS,
				payoutAddress,
				BROWSER_RESEARCH_AGENT.name,
				BROWSER_RESEARCH_AGENT.categoryId,
				BROWSER_RESEARCH_AGENT.capability,
				[...BROWSER_RESEARCH_AGENT.tags],
				BROWSER_RESEARCH_AGENT.priceMinor,
				`${publicUrl}/run`,
				`${BROWSER_RESEARCH_AGENT.id}@local.aicp.invalid`,
			],
		);
		// 数据库保存的只是 LocalDecryptor 可识别的标记；真实共享密钥只存在于进程环境，
		// 不会通过目录同步器写入数据库或日志。
		await database.query(
			`INSERT INTO agent_credentials(agent_id,encrypted_secret,key_version)
			 VALUES ($1,$2,1)
			 ON CONFLICT (agent_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret`,
			[
				BROWSER_RESEARCH_AGENT.platformId,
				`local-dev:${BROWSER_RESEARCH_AGENT.platformId}`,
			],
		);
		await database.query(
			`INSERT INTO agent_status_config(agent_id) VALUES ($1)
			 ON CONFLICT (agent_id) DO NOTHING`,
			[BROWSER_RESEARCH_AGENT.platformId],
		);
		await database.query(
			`INSERT INTO agent_health_probe_schedule(agent_id,next_probe_at)
			 VALUES ($1,now()) ON CONFLICT (agent_id) DO UPDATE SET next_probe_at=now()`,
			[BROWSER_RESEARCH_AGENT.platformId],
		);
		await database.query("COMMIT");
	} catch (error) {
		await database.query("ROLLBACK");
		throw error;
	}
}

function assertLoopback(value: string, field: string): void {
	const url = new URL(value);
	if (!isLoopbackHost(url.hostname))
		throw new Error(`${field} 必须指向本机回环地址`);
}

function normalizedLoopbackUrl(value: string): string {
	const url = new URL(value);
	if (
		!isLoopbackHost(url.hostname) ||
		(url.protocol !== "http:" && url.protocol !== "https:")
	) {
		throw new Error("BROWSER_AGENT_PUBLIC_URL 必须使用本机 HTTP(S) 地址");
	}
	if (
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new Error("BROWSER_AGENT_PUBLIC_URL 不能包含凭据、查询参数或片段");
	}
	return url.toString().replace(/\/$/, "");
}

function isLoopbackHost(hostname: string): boolean {
	return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(hostname);
}

async function main(): Promise<void> {
	const config = EnvironmentSchema.parse(process.env);
	const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
	try {
		await bootstrapBrowserResearchAgent(process.env, pool);
		console.log(`已同步平台 Agent：${BROWSER_RESEARCH_AGENT.name}`);
	} finally {
		await pool.end();
	}
}

if (
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch((error: unknown) => {
		console.error(
			error instanceof Error ? error.message : "网页调研助手目录同步失败",
		);
		process.exitCode = 1;
	});
}
