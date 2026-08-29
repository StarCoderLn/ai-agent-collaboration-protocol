import { pathToFileURL } from "node:url";

import pg from "pg";
import { z } from "zod";

import { WORKFLOW_AGENT_CATALOG } from "./catalog.js";

const EnvironmentSchema = z.object({
  AICP_LOCAL_DEMO_MODE: z.literal("true"),
  DATABASE_URL: z.url(),
  WORKFLOW_AGENT_PUBLIC_URL: z.url().default("http://127.0.0.1:9202"),
  // Anvil 第二个公开开发账户。与发布者账户分离，才能在本地真实验证服务端角色授权。
  AICP_LOCAL_ARBITRATOR_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/)
    .default("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
});

type QueryResult = Readonly<{ rowCount: number | null }>;
export interface BootstrapDatabase {
  query(text: string, values?: readonly unknown[]): Promise<QueryResult>;
}

/**
 * 把代码目录中的 9 个 Agent 以稳定 UUID 幂等写入正式平台表。脚本不保存真实密钥，
 * `local-dev:` 只是 Go LocalDecryptor 可识别的 marker，实际 secret 始终来自进程环境。
 */
export async function bootstrapLocalAgents(
  environment: NodeJS.ProcessEnv,
  database: BootstrapDatabase,
): Promise<number> {
  const parsed = EnvironmentSchema.parse(environment);
  assertLoopback(parsed.DATABASE_URL, "DATABASE_URL");
  const publicUrl = normalizedLoopbackUrl(parsed.WORKFLOW_AGENT_PUBLIC_URL);

  await database.query("BEGIN");
  try {
    await seedCategories(database);
    for (const agent of WORKFLOW_AGENT_CATALOG) {
      const endpoint = `${publicUrl}/v1/agents/${agent.id}`;
      await database.query(
        `INSERT INTO agents(
           id,provider_wallet_address,payout_wallet_address,name,category_id,capability_desc,tags,pricing_type,
           price_amount,price_currency,service_endpoint,email,status,
           estimated_duration_seconds,response_minutes
         -- 本地目录没有真实提供者配置收款钱包，因此显式复用稳定测试所有者地址。
         -- 仍分别写入两个字段，避免用数据库默认值掩盖正式注册流程遗漏收款地址。
         ) VALUES ($1,$2,$2,$3,$4,$5,$6,'fixed',$7,'USDC',$8,$9,'active',$10,1)
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name,category_id=EXCLUDED.category_id,
           capability_desc=EXCLUDED.capability_desc,tags=EXCLUDED.tags,
           pricing_type=EXCLUDED.pricing_type,price_amount=EXCLUDED.price_amount,
           price_currency=EXCLUDED.price_currency,service_endpoint=EXCLUDED.service_endpoint,
           email=EXCLUDED.email,status='active',pause_reason=NULL,
           estimated_duration_seconds=EXCLUDED.estimated_duration_seconds,
           response_minutes=EXCLUDED.response_minutes`,
        [
          agent.platformId,
          localProviderWallet(agent.platformId),
          agent.name,
          agent.categoryId,
          agent.capability,
          [...agent.tags],
          agent.priceMinor,
          endpoint,
          `${agent.id}@local.aicp.invalid`,
          estimatedSeconds(agent.step),
        ],
      );
      await database.query(
        `INSERT INTO agent_credentials(agent_id,encrypted_secret,key_version)
         VALUES ($1,$2,1)
         ON CONFLICT (agent_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret`,
        [agent.platformId, `local-dev:${agent.platformId}`],
      );
      await database.query(
        `INSERT INTO agent_status_config(agent_id) VALUES ($1)
         ON CONFLICT (agent_id) DO NOTHING`,
        [agent.platformId],
      );
      await database.query(
        `INSERT INTO agent_health_probe_schedule(agent_id,next_probe_at)
         VALUES ($1,now()) ON CONFLICT (agent_id) DO UPDATE SET next_probe_at=now()`,
        [agent.platformId],
      );
    }
    await database.query(
      `INSERT INTO platform_actor_roles(actor_id,role,granted_by)
       VALUES (lower($1),'arbitrator','local-mvp-bootstrap')
       ON CONFLICT (actor_id,role) DO UPDATE SET granted_by=EXCLUDED.granted_by`,
      [parsed.AICP_LOCAL_ARBITRATOR_ADDRESS],
    );
    await database.query("COMMIT");
    return WORKFLOW_AGENT_CATALOG.length;
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
}

async function seedCategories(database: BootstrapDatabase): Promise<void> {
  // 本地库可能尚未应用最新 migration；使用相同稳定 ID 幂等补齐，不另造分类知识。
  await database.query(
    `INSERT INTO categories(id,parent_id,name,slug,version) VALUES
       ('40000000-0000-4000-8000-000000000021','40000000-0000-4000-8000-000000000001','产品需求与 PRD','product-requirements',1),
       ('40000000-0000-4000-8000-000000000022','40000000-0000-4000-8000-000000000003','产品界面设计','product-interface-design',1),
       ('40000000-0000-4000-8000-000000000023','40000000-0000-4000-8000-000000000001','软件开发','software-development',1)
     ON CONFLICT (id) DO NOTHING`,
  );
}

function assertLoopback(value: string, field: string): void {
  const url = new URL(value);
  if (!isLoopbackHost(url.hostname)) throw new Error(`${field} must point to a loopback host in local demo mode`);
}

function normalizedLoopbackUrl(value: string): string {
  const url = new URL(value);
  if (!isLoopbackHost(url.hostname) || (url.protocol !== "http:" && url.protocol !== "https:")) {
    throw new Error("WORKFLOW_AGENT_PUBLIC_URL must use http/https on a loopback host");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("WORKFLOW_AGENT_PUBLIC_URL cannot contain credentials, query parameters or fragments");
  }
  return url.toString().replace(/\/$/, "");
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function localProviderWallet(platformId: string): string {
  // 稳定测试地址只用于满足目录所有权字段，不持有资金，也不会作为本地托管签名账户。
  return `0x${platformId.replaceAll("-", "").slice(0, 40).padEnd(40, "0")}`;
}

function estimatedSeconds(step: "requirements" | "design" | "code"): number {
  return step === "code" ? 600 : step === "design" ? 360 : 300;
}

async function main(): Promise<void> {
  const config = EnvironmentSchema.parse(process.env);
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  try {
    const count = await bootstrapLocalAgents(process.env, pool);
    console.log(`bootstrapped ${count} local Product Workflow agents`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "local bootstrap failed");
    process.exitCode = 1;
  });
}
