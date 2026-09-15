/**
 * `GET /api/agents/:id` 读取接口的核心业务逻辑（2.agent-registration T-012）。
 *
 * 契约（design.md 模块 5「接口契约」）：需携带有效 session；响应为 Agent 档案字段，
 * 不含 `encrypted_secret`（`Agent` 领域类型本身就不携带凭证字段，见 agent.ts 顶部
 * 注释，物理表隔离 + 领域类型隔离双重保证，不依赖本函数手动摘除字段）；仅归属该
 * `provider_wallet_address` 的 session 可读，否则 403。
 *
 * 校验顺序沿用 `patch-agent.ts` 已确立的先例（存在性优先于归属判断，返回码语义与
 * `AGENT_NOT_FOUND`/`AGENT_ACCESS_DENIED` 保持跨接口一致，见 errors.ts）。
 *
 * 依赖注入使用比 agent.ts 完整 `AgentRepository`（含 `applyPatch`）更窄的 `AgentReader`
 * 接口：本函数只读，不应强迫调用方（生产实现、测试 fake）实现从未使用的写方法
 * （接口隔离，降低耦合面）。
 */

import { type Agent, isWellFormedAgentId } from "./agent";
import { AgentApiError } from "./errors";
import { walletAddressesMatch } from "./ethereum-address";

export interface AgentReader {
	findById(agentId: string): Promise<Agent | null>;
}

export interface GetAgentDeps {
	agentRepository: AgentReader;
}

export interface GetAgentParams {
	agentId: string;
	/** 认证边界已确认身份的操作者钱包地址（见 1.agent-protocol-contract / T-010）。 */
	actorId: string;
}

/**
 * 执行 `GET /api/agents/:id` 的完整业务逻辑：查找 → 校验归属 → 返回。
 *
 * 抛出 `AgentApiError`：
 * - `AGENT_NOT_FOUND`：`agentId` 不存在，或格式不合法（不查库直接判定不存在——路径参数
 *   非法 UUID 若直接透传给 PostgreSQL 会抛出 `invalid input syntax for type uuid`，
 *   属于非预期的 5xx 而非「资源不存在」的 404，语义上更贴近后者，且避免把 DB 层
 *   报错细节泄露到响应体，security.md 第 23 条）。
 * - `AGENT_ACCESS_DENIED`：`actorId` 与该 Agent 档案的 `providerWalletAddress` 不一致
 *   （security.md 认证与授权第 1/2/4 条：权限判断须校验资源归属，不得凭已认证身份
 *   读取任意 `agentId`）。
 */
export async function getAgent(
	deps: GetAgentDeps,
	params: GetAgentParams,
): Promise<Agent> {
	const { agentId, actorId } = params;

	if (!isWellFormedAgentId(agentId)) {
		throw new AgentApiError("AGENT_NOT_FOUND", `Agent ${agentId} 不存在`);
	}

	const existing = await deps.agentRepository.findById(agentId);
	if (!existing) {
		throw new AgentApiError("AGENT_NOT_FOUND", `Agent ${agentId} 不存在`);
	}

	if (!walletAddressesMatch(existing.providerWalletAddress, actorId)) {
		throw new AgentApiError("AGENT_ACCESS_DENIED", "无权读取该 Agent 档案");
	}

	return existing;
}
