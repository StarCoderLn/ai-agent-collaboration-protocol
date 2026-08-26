#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import pg from "../agents/product-workflow/node_modules/pg/lib/index.js";
import { z } from "../agents/product-workflow/node_modules/zod/index.js";

const EnvironmentSchema = z.object({
	AICP_LOCAL_DEMO_MODE: z.literal("true"),
	DATABASE_URL: z.url(),
	ESCROW_CHAIN_ID: z.literal("31337"),
	ESCROW_CONTRACT_ADDRESS: z.string().regex(/^0x[0-9a-f]{40}$/),
});

/**
 * Anvil 每次全新启动都会回到 genesis；同一默认部署账户又会产生相同的合约地址。
 * 若沿用 PostgreSQL 中旧链的 next_block，同地址的新链事件会被永久跳过。这里只删除
 * 精确链+合约游标，让正式同步器从 ESCROW_START_BLOCK 重建；业务记录和审计事实保留。
 */
export async function resetFreshLocalChainCursor(environment, database) {
	const parsed = EnvironmentSchema.parse(environment);
	const url = new URL(parsed.DATABASE_URL);
	if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
		throw new Error("DATABASE_URL must point to loopback in local demo mode");
	}
	const result = await database.query(
		"DELETE FROM chain_event_cursor WHERE chain_id=$1 AND contract_address=$2",
		[parsed.ESCROW_CHAIN_ID, parsed.ESCROW_CONTRACT_ADDRESS],
	);
	return result.rowCount ?? 0;
}

async function main() {
	const config = EnvironmentSchema.parse(process.env);
	const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
	try {
		const count = await resetFreshLocalChainCursor(process.env, pool);
		console.log(`reset ${count} stale local chain cursor`);
	} finally {
		await pool.end();
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : "local chain bootstrap failed");
		process.exitCode = 1;
	});
}
