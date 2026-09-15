/**
 * Agent 档案领域类型（2.agent-registration，权威定义见 design.md「数据模型」）。
 *
 * 有意不包含 `agent_credentials` 的任何字段：凭证密文与档案物理分表存储
 * （design.md 模块 1），领域类型层面同样隔离，避免任何一处 `Agent` 对象
 * 意外携带凭证相关数据。
 */
/**
 * `agents.id`（T-001 migration，UUID 主键）的结构校验（单一权威位置，codex review
 * T-011 P2 修复）。非法 UUID 若直接透传给 PostgreSQL 会抛出
 * `invalid input syntax for type uuid`，冒泡成非预期的 500 而不是 `AGENT_NOT_FOUND`
 * 404——`get-agent.ts` 已用这条规则做过一次前置守卫，`patch-agent.ts`/`credentials.ts`
 * 必须复用同一实现，不得各自重复判断或遗漏。
 */
const AGENT_ID_PATTERN =
	/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isWellFormedAgentId(agentId: string): boolean {
	return AGENT_ID_PATTERN.test(agentId);
}

export interface Agent {
	id: string;
	/** Ethereum 地址（0x + 40 位十六进制）。一经创建不可通过 PATCH 修改，见 AC-004。 */
	providerWalletAddress: string;
	/** 结算收款地址；可与所有者钱包不同，但不赋予任何 Agent 管理权限。 */
	payoutWalletAddress: string;
	name: string;
	categoryId: string;
	capabilityDesc: string;
	tags: string[];
	pricingType: string;
	/** 最小单位整数金额，禁止浮点（AGENTS.md 安全规则第 5 条）。 */
	priceAmount: bigint;
	priceCurrency: string;
	serviceEndpoint: string;
	/** 历史兼容的可选站外联系方式；新上架流程不再收集，旧档案仍可保留原值。 */
	email: string | null;
	/**
	 * 状态机权威实现在 Go 分发引擎（specs/3.agent-health-lifecycle），
	 * 本 feature 的编辑接口不允许客户端直接改写，只读展示。
	 */
	status: "pending_review" | "active" | "paused" | "delisted";
	pauseReason: "health_check" | "manual" | null;
	createdAt: Date;
	updatedAt: Date;
}

/**
 * `PATCH /api/agents/:id` 允许编辑的字段集合（requirements.md F-005：
 * 「可修改除钱包地址外的字段」）。`status`/`pauseReason` 不在此列——
 * 状态机权威实现在 3.agent-health-lifecycle，本接口不提供直接改写路径，
 * 避免同一状态迁移规则出现第二个入口（AGENTS.md 第 9 条）。
 */
export const AGENT_PATCHABLE_FIELDS = [
	"name",
	"categoryId",
	"capabilityDesc",
	"tags",
	"pricingType",
	"priceAmount",
	"priceCurrency",
	"serviceEndpoint",
	"email",
] as const;

export type AgentPatchableField = (typeof AGENT_PATCHABLE_FIELDS)[number];

export type AgentPatch = Partial<Pick<Agent, AgentPatchableField>>;

/**
 * Agent 档案的持久化访问接口，供 `patchAgent` 依赖注入使用。
 * 具体实现（PostgreSQL 查询/写入）由承载本模块的服务基础设施提供，
 * 不在本文件内耦合任何数据库客户端，便于用 fake 实现做单元测试
 * （沿用 `envelope-encryption.ts` 的依赖注入约定）。
 */
export interface AgentRepository {
	findById(agentId: string): Promise<Agent | null>;
	/** 应用补丁并落库，返回更新后的完整记录；调用方保证 patch 不含 walletAddress。 */
	applyPatch(agentId: string, patch: AgentPatch): Promise<Agent>;
}

// audit_logs 是跨 feature 的平台共享表；发布任务、验收和争议同样需要 publisher 类型。
export type AuditActorType = "provider" | "publisher" | "admin" | "system";

export interface AuditLogEntry {
	actorId: string;
	actorType: AuditActorType;
	action: string;
	targetType: string;
	targetId: string;
	/** 变更前摘要，禁止包含凭证明文/密文片段或完整钱包签名（design.md「安全考虑」）。 */
	beforeSummary: Record<string, unknown>;
	afterSummary: Record<string, unknown>;
}

/** 审计日志写入接口，权威表结构见 design.md 模块 1（平台级共享 `audit_logs` 表）。 */
export interface AuditLogWriter {
	write(entry: AuditLogEntry): Promise<void>;
}
