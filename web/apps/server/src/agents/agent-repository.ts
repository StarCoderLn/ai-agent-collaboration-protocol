/**
 * Agent 档案写入仓储（2.agent-registration T-003；T-011 收敛事务边界）。
 *
 * 权威表结构见 services/business-service/migrations/0001_agent_registration.up.sql。
 *
 * T-011 变更：`PgAgentRepository` 不再在内部自行开启事务（原先 `createAgentWithCredential`
 * 内部调用 `withTransaction`）。创建 Agent 需要原子写入 `agents` + `agent_credentials`
 * 两张表，同时还要把审计日志写入、（创建场景下）幂等提交收敛进同一个事务
 * （design.md 模块 1/2、tasks.md T-011）——事务边界必须覆盖仓储、审计、幂等三者，
 * 因此本类改为接受一个 `QueryExecutor`（可以是共享 `Pool`，也可以是
 * `withTransaction` 回调中的事务内 `client`），由调用方（生产依赖装配层，见
 * `http/create-agent-production-deps.ts` 等）负责开启/提交/回滚事务，并把同一个
 * `client` 传给仓储、`PgAuditLogWriter`、`PgIdempotencyStore` 构造，不在本类内部
 * 隐藏事务边界。
 */

import type { QueryExecutor } from "../db/pool";
import { normalizeMatchingTags } from "../platform/matching-tags";
import { loadMatchingTagTaxonomy } from "../platform/tag-taxonomy";
import type {
	Agent,
	AgentPatch,
	AgentRepository as AgentProfileRepository,
} from "./agent";
import type { CreateAgentInput } from "./create-agent-input";

export interface CreatedAgent {
	agentId: string;
	status: string;
}

export interface AgentRepository {
	createAgentWithCredential(
		input: CreateAgentInput,
		encryptedSecret: string | null,
	): Promise<CreatedAgent>;
}

interface AgentInsertRow {
	id: string;
	status: string;
}

interface AgentRow {
	id: string;
	provider_wallet_address: string;
	payout_wallet_address: string;
	name: string;
	category_id: string;
	capability_desc: string;
	tags: string[];
	pricing_type: string;
	price_amount: string;
	price_currency: string;
	service_endpoint: string;
	email: string | null;
	status: Agent["status"];
	pause_reason: Agent["pauseReason"];
	created_at: Date;
	updated_at: Date;
}

/** `AgentPatch` 字段名到 `agents` 表列名的映射，供 `applyPatch` 动态拼装 `UPDATE`。 */
const PATCH_FIELD_TO_COLUMN: Record<keyof AgentPatch, string> = {
	name: "name",
	categoryId: "category_id",
	capabilityDesc: "capability_desc",
	tags: "tags",
	pricingType: "pricing_type",
	priceAmount: "price_amount",
	priceCurrency: "price_currency",
	serviceEndpoint: "service_endpoint",
	email: "email",
};

/**
 * `agents` / `agent_credentials` 的 PostgreSQL 仓储实现。同时实现两个消费方接口
 * （本文件的 `AgentRepository`：`createAgentWithCredential`，供 T-003 创建流程使用；
 * `agent.ts` 的 `AgentRepository`：`findById`/`applyPatch`，供 T-004/T-005 编辑与凭证
 * 替换流程使用）——两个接口描述的是同一张 `agents` 表的不同操作面，合并到一个类
 * 是为了让调用方在同一个事务内共享同一个 `client` 实例，不必为同一张表维护两个
 * 各自持有连接的仓储对象。
 */
export class PgAgentRepository
	implements AgentRepository, AgentProfileRepository
{
	constructor(private readonly db: QueryExecutor) {}

	async createAgentWithCredential(
		input: CreateAgentInput,
		encryptedSecret: string | null,
	): Promise<CreatedAgent> {
		// 表单允许提供者使用自己熟悉的中文、英文或历史叫法。真正落库前必须通过与任务
		// 相同的数据库词表收敛为 canonical 标签，否则语义相同的双方仍会精确匹配失败。
		const normalizedTags = await this.normalizeTags(input.tags);
		const agentResult = await this.db.query<AgentInsertRow>(
			`INSERT INTO agents (
         provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags,
         pricing_type, price_amount, price_currency, service_endpoint, integration_mode, email
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, status`,
			[
				input.walletAddress,
				input.payoutWalletAddress,
				input.name,
				input.categoryId,
				input.capabilityDesc,
				normalizedTags,
				input.pricingType,
				input.price.amount,
				input.price.currency,
				input.serviceEndpoint,
				input.integrationMode,
				input.email ?? null,
			],
		);
		const row = agentResult.rows[0];
		if (!row) {
			throw new Error("PgAgentRepository: INSERT INTO agents 未返回新建行");
		}

		// 公开快速 HTTP Agent 不需要伪造占位密钥。没有凭证行就是“调用时不发送
		// Authorization”的唯一持久化表达；有访问密钥时仍沿用原信封加密表。
		if (encryptedSecret !== null) {
			await this.db.query(
				`INSERT INTO agent_credentials (agent_id, encrypted_secret, key_version)
         VALUES ($1, $2, 1)`,
				[row.id, encryptedSecret],
			);
		}

		// 提供者案例和 Agent 档案共用外层创建事务：任何一条案例写入失败时，档案、凭证、
		// 审计和幂等结果都会一起回滚，不会留下“市场已有 Agent 但案例只写了一半”的状态。
		for (const portfolioCase of input.portfolioCases ?? []) {
			await this.db.query(
				`INSERT INTO agent_portfolio_cases (
           agent_id,title,summary,artifact_kind,preview_ref,category_id,tags
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
				[
					row.id,
					portfolioCase.title,
					portfolioCase.summary,
					portfolioCase.artifactKind,
					portfolioCase.previewRef,
					input.categoryId,
					normalizedTags,
				],
			);
		}

		return { agentId: row.id, status: row.status };
	}

	async findById(agentId: string): Promise<Agent | null> {
		const result = await this.db.query<AgentRow>(
			`SELECT id, provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags,
              pricing_type, price_amount, price_currency, service_endpoint, email,
              status, pause_reason, created_at, updated_at
       FROM agents WHERE id = $1`,
			[agentId],
		);
		const row = result.rows[0];
		return row ? toAgent(row) : null;
	}

	async applyPatch(agentId: string, patch: AgentPatch): Promise<Agent> {
		const fields = Object.keys(patch) as (keyof AgentPatch)[];
		if (fields.length === 0) {
			throw new Error(
				"PgAgentRepository.applyPatch: patch 不能为空（调用方应在此之前短路空补丁）",
			);
		}

		const normalizedTags =
			patch.tags === undefined
				? undefined
				: await this.normalizeTags(patch.tags);
		const assignments: string[] = [];
		const values: unknown[] = [];
		fields.forEach((field, index) => {
			const column = PATCH_FIELD_TO_COLUMN[field];
			const value = field === "tags" ? normalizedTags : patch[field];
			// priceAmount 是 bigint，pg 驱动按字符串/数字传参均可正确绑定到 BIGINT 列；
			// 显式转字符串避免驱动对 bigint 类型的隐式处理差异。
			values.push(
				field === "priceAmount" ? (value as bigint).toString() : value,
			);
			assignments.push(`${column} = $${index + 1}`);
		});
		values.push(agentId);

		const result = await this.db.query<AgentRow>(
			`UPDATE agents SET ${assignments.join(", ")} WHERE id = $${values.length} RETURNING
         id, provider_wallet_address, payout_wallet_address, name, category_id, capability_desc, tags,
         pricing_type, price_amount, price_currency, service_endpoint, email,
         status, pause_reason, created_at, updated_at`,
			values,
		);
		const row = result.rows[0];
		if (!row) {
			throw new Error(
				`PgAgentRepository.applyPatch: agent ${agentId} 不存在（调用方应已先 findById 校验）`,
			);
		}
		return toAgent(row);
	}

	/**
	 * 标签词表属于持久化边界的一部分：所有创建和编辑入口最终都经过本仓储，因此即使
	 * 调用方不是当前 Web 表单，也无法绕过中英文同义词归一后写入不可匹配的数据。
	 */
	private async normalizeTags(
		tags: readonly string[],
	): Promise<readonly string[]> {
		const taxonomy = await loadMatchingTagTaxonomy(this.db);
		return normalizeMatchingTags(tags, taxonomy.canonicalByAlias);
	}
}

function toAgent(row: AgentRow): Agent {
	return {
		id: row.id,
		providerWalletAddress: row.provider_wallet_address,
		payoutWalletAddress: row.payout_wallet_address,
		name: row.name,
		categoryId: row.category_id,
		capabilityDesc: row.capability_desc,
		tags: row.tags,
		pricingType: row.pricing_type,
		priceAmount: BigInt(row.price_amount),
		priceCurrency: row.price_currency,
		serviceEndpoint: row.service_endpoint,
		email: row.email,
		status: row.status,
		pauseReason: row.pause_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

/**
 * `agent_credentials` 的 PostgreSQL 覆盖写实现（供 T-005 `replaceAgentCredentials` 使用）。
 * `replace()` 用 `INSERT ... ON CONFLICT DO UPDATE` 把"不存在则创建 key_version=1，
 * 存在则覆盖密文并递增 key_version"表达为单条原子语句，`wasConfigured` 用
 * `xmax = 0`（PostgreSQL 惯用手法：新插入行的 `xmax` 为 0，`ON CONFLICT DO UPDATE`
 * 命中的行 `xmax` 会被设为当前事务 ID）区分本次是插入还是更新，不需要额外一次查询。
 */
export class PgAgentCredentialStore {
	constructor(private readonly db: QueryExecutor) {}

	async replace(
		agentId: string,
		encryptedSecret: string,
	): Promise<{ keyVersion: number; wasConfigured: boolean }> {
		const result = await this.db.query<{
			key_version: number;
			inserted: boolean;
		}>(
			`INSERT INTO agent_credentials (agent_id, encrypted_secret, key_version)
       VALUES ($1, $2, 1)
       ON CONFLICT (agent_id) DO UPDATE
         SET encrypted_secret = EXCLUDED.encrypted_secret,
             key_version = agent_credentials.key_version + 1
       RETURNING key_version, (xmax = 0) AS inserted`,
			[agentId, encryptedSecret],
		);
		const row = result.rows[0];
		if (!row) {
			throw new Error(
				`PgAgentCredentialStore.replace: agent ${agentId} 的凭证覆盖写未返回结果`,
			);
		}
		return { keyVersion: row.key_version, wasConfigured: !row.inserted };
	}
}
