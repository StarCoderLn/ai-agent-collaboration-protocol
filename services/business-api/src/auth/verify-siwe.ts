/**
 * SIWE（EIP-4361）签名校验领域逻辑（2.agent-registration T-010）。
 *
 * 权威设计见 specs/2.agent-registration/design.md 「模块 5」。校验顺序：
 * 1. 结构解析（`SiweMessage` 构造函数，格式非法直接失败）。
 * 2. domain/uri/chainId 绑定校验（`siwe` 库的 `verify()` 不校验 uri/chainId，
 *    必须显式比对，防跨站冒用会话——这是本模块新增，`siwe` 官方库不提供的部分）。
 * 3. 钱包地址格式/EIP-55 校验和校验（复用 `agents/ethereum-address.ts` 单一权威实现）。
 * 4. 签名与 nonce 匹配校验（`siwe` 库负责 ECDSA 恢复地址比对、时间窗口、nonce 参数匹配）。
 * 5. nonce 原子消费（放在签名校验成功之后：签名失败的尝试不消耗 nonce，允许用户
 *    用同一个 nonce 重试；但最终消费仍是原子操作，防止并发重放同一个合法签名）。
 *
 * 所有失败路径统一抛 `AuthApiError("SIWE_VERIFICATION_FAILED")`，不区分具体在哪一步
 * 失败（design.md 接口契约：「失败一律 401，不泄露具体校验失败在哪一步」）。
 */

import { SiweMessage } from "siwe";
import { isValidEthereumAddress, toChecksumAddress } from "../agents/ethereum-address";
import { AuthApiError } from "./errors";
import type { NonceStore } from "./nonce-store";
import type { SessionRecord, SessionStore } from "./session-store";
import type { SiweConfig } from "./siwe-config";

export interface VerifySiweDeps {
  nonceStore: NonceStore;
  sessionStore: SessionStore;
  config: SiweConfig;
  now?: () => Date;
}

export interface VerifySiweInput {
  message: unknown;
  signature: unknown;
}

export async function verifySiwe(deps: VerifySiweDeps, input: VerifySiweInput): Promise<SessionRecord> {
  if (typeof input.message !== "string" || !input.message) {
    throw new AuthApiError("SIWE_VERIFICATION_FAILED");
  }
  if (typeof input.signature !== "string" || !input.signature) {
    throw new AuthApiError("SIWE_VERIFICATION_FAILED");
  }

  let parsed: SiweMessage;
  try {
    parsed = new SiweMessage(input.message);
  } catch {
    throw new AuthApiError("SIWE_VERIFICATION_FAILED");
  }

  // domain/uri/chainId 绑定：siwe 库的 verify() 只会校验 domain（因为下面传了该参数）
  // 与 nonce，不会校验 uri/chainId，这里必须显式比对（防跨站冒用会话的教训）。
  if (
    parsed.domain !== deps.config.expectedDomain ||
    parsed.uri !== deps.config.expectedUri ||
    parsed.chainId !== deps.config.expectedChainId
  ) {
    throw new AuthApiError("SIWE_VERIFICATION_FAILED");
  }

  if (!isValidEthereumAddress(parsed.address)) {
    throw new AuthApiError("SIWE_VERIFICATION_FAILED");
  }

  const now = (deps.now ?? (() => new Date()))();

  let verifyResult;
  try {
    verifyResult = await parsed.verify({
      signature: input.signature,
      domain: deps.config.expectedDomain,
      nonce: parsed.nonce,
      time: now.toISOString(),
    });
  } catch {
    throw new AuthApiError("SIWE_VERIFICATION_FAILED");
  }

  if (!verifyResult.success) {
    throw new AuthApiError("SIWE_VERIFICATION_FAILED");
  }

  // nonce 单次使用：签名校验通过后才原子消费，避免签名失败的尝试无谓消耗 nonce；
  // 最终以数据库的原子 UPDATE 作为唯一真相来源，防止并发重放同一份合法签名消息。
  const consumed = await deps.nonceStore.consume(parsed.nonce);
  if (!consumed) {
    throw new AuthApiError("SIWE_VERIFICATION_FAILED");
  }

  const normalizedAddress = toChecksumAddress(parsed.address);
  return deps.sessionStore.create(normalizedAddress);
}
