/**
 * SIWE 消息校验的期望值配置（2.agent-registration T-010）。
 *
 * `siwe` 库的 `SiweMessage.verify()` 只校验签名、`domain`（若传入）与 `nonce`
 * （若传入），不会校验 `uri`/`chainId`；design.md 引用的教训明确要求「须绑定
 * domain/uri/chainId，不能只验签名+nonce+地址,防跨站冒用会话」，因此本模块显式
 * 提供期望的 domain/uri/chainId 三元组，由 `verify-siwe.ts` 在调用签名校验之外
 * 额外比对，单一权威位置读取，不在多处各自拼配置。
 *
 * 期望值经 env 包读取（AGENTS.md 安全规则第 12 条），不硬编码；`SIWE_EXPECTED_URI`
 * 同时用于推导 CORS 允许来源（跨源 Cookie 会话需要 credentialed CORS，见
 * `http/cors.ts`），避免维护两份重复的前端来源配置。
 */

import { getRequiredEnv } from "../config/env";

/** EIP-4361 statement 只能使用 RFC 3986 ASCII 字符；中文会被 siwe v3 解析器拒绝。 */
export const AICP_SIWE_STATEMENT =
	"Sign in to AICP. This signature does not create a transaction or cost gas.";

export interface SiweConfig {
	/** SIWE 消息 `domain` 字段的期望值（不含协议前缀），如 "app.example.com"。 */
	expectedDomain: string;
	/** SIWE 消息 `uri` 字段的期望值（完整 URI），如 "https://app.example.com/login"。 */
	expectedUri: string;
	/** SIWE 消息 `chainId` 字段的期望值（EIP-155），MVP 固定绑定到 Ethereum 目标链。 */
	expectedChainId: number;
}

export function loadSiweConfigFromEnv(): SiweConfig {
	const expectedDomain = getRequiredEnv("SIWE_EXPECTED_DOMAIN");
	const expectedUri = getRequiredEnv("SIWE_EXPECTED_URI");
	const chainIdRaw = getRequiredEnv("SIWE_EXPECTED_CHAIN_ID");
	const expectedChainId = Number.parseInt(chainIdRaw, 10);
	if (!Number.isInteger(expectedChainId) || expectedChainId <= 0) {
		throw new Error(
			`SIWE_EXPECTED_CHAIN_ID 必须是正整数，实际值: "${chainIdRaw}"`,
		);
	}
	return { expectedDomain, expectedUri, expectedChainId };
}

/** 从 `expectedUri` 推导出的 origin，供 CORS `Access-Control-Allow-Origin` 使用。 */
export function corsOriginFromSiweConfig(config: SiweConfig): string {
	return new URL(config.expectedUri).origin;
}
