import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";
import { PRESENTATION_AGENT_CATALOG } from "./catalog.js";

const EnvironmentSchema = z.object({
	AICP_LOCAL_DEMO_MODE: z.literal("true"),
	DATABASE_URL: z.url(),
	PRESENTATION_AGENT_PUBLIC_URL: z.url().default("http://127.0.0.1:9302"),
	AICP_PLATFORM_AGENT_OWNER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

type Database = Readonly<{
	query(text: string, values?: readonly unknown[]): Promise<unknown>;
}>;

/** 将可真实执行的演示文稿能力幂等投影到平台目录，并同步精确契约硬门禁。 */
export async function bootstrapPresentationAgents(
	environment: NodeJS.ProcessEnv,
	database: Database,
): Promise<number> {
	const config = EnvironmentSchema.parse(environment);
	const databaseUrl = new URL(config.DATABASE_URL);
	const publicUrl = new URL(config.PRESENTATION_AGENT_PUBLIC_URL);
	if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(databaseUrl.hostname))
		throw new Error("DATABASE_URL 必须指向本机回环地址");
	if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(publicUrl.hostname))
		throw new Error("PRESENTATION_AGENT_PUBLIC_URL 必须指向本机回环地址");
	const endpoint = `${publicUrl.toString().replace(/\/$/, "")}/run`;
	await database.query("BEGIN");
	try {
		for (const agent of PRESENTATION_AGENT_CATALOG) {
			await database.query(
				`INSERT INTO agents(
				 id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,
				 pricing_type,price_amount,price_currency,service_endpoint,integration_mode,email,status,
				 estimated_duration_seconds,response_minutes
				) VALUES ($1,$2,$2,$3,$4,$5,$6,'fixed',$7,'USDC',$8,'http_json',$9,'active',600,1)
				ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,category_id=EXCLUDED.category_id,
				 capability_desc=EXCLUDED.capability_desc,tags=EXCLUDED.tags,price_amount=EXCLUDED.price_amount,
				 service_endpoint=EXCLUDED.service_endpoint,integration_mode='http_json',status='active',pause_reason=NULL`,
				[
					agent.platformId,
					config.AICP_PLATFORM_AGENT_OWNER_ADDRESS,
					agent.name,
					agent.categoryId,
					agent.capability,
					[...agent.tags],
					agent.priceMinor,
					endpoint,
					`${agent.id}@local.aicp.invalid`,
				],
			);
			await database.query(
				`INSERT INTO agent_credentials(agent_id,encrypted_secret,key_version) VALUES ($1,$2,1)
				 ON CONFLICT (agent_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret`,
				[agent.platformId, `local-dev:${agent.platformId}`],
			);
			await database.query("DELETE FROM agent_workflow_contracts WHERE agent_id=$1", [agent.platformId]);
			await database.query(
				`INSERT INTO agent_workflow_contracts(agent_id,input_contract,output_contract)
				 VALUES ($1,$2,$3)`,
				[agent.platformId, agent.inputContract, agent.outputContract],
			);
			await database.query(
				`INSERT INTO agent_status_config(agent_id) VALUES ($1) ON CONFLICT (agent_id) DO NOTHING`,
				[agent.platformId],
			);
			await database.query(
				`INSERT INTO agent_health_probe_schedule(agent_id,next_probe_at) VALUES ($1,now())
				 ON CONFLICT (agent_id) DO UPDATE SET next_probe_at=now()`,
				[agent.platformId],
			);
		}
		await database.query("COMMIT");
		return PRESENTATION_AGENT_CATALOG.length;
	} catch (error) {
		await database.query("ROLLBACK");
		throw error;
	}
}

async function main() {
	const config = EnvironmentSchema.parse(process.env);
	const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
	try {
		const count = await bootstrapPresentationAgents(process.env, pool);
		console.log(`已同步 ${count} 个演示文稿 Agent`);
	} finally {
		await pool.end();
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : "演示文稿 Agent 同步失败");
		process.exitCode = 1;
	});
}
