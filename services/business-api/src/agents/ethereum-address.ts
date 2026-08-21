/**
 * Ethereum 钱包地址格式与 EIP-55 大小写校验（2.agent-registration T-003）。
 *
 * `agents.provider_wallet_address` 的 DB CHECK 只做结构性校验
 * （`^0x[a-fA-F0-9]{40}$`，见 services/business-service/migrations/0001_agent_registration.up.sql）；
 * EIP-55 校验和大小写校验按 migration 注释与 tasks.md 风险点，权威留给应用层实现，
 * 避免大小写错误的地址通过校验后在后续合约交互（feature 5/6）中被解析成另一个地址。
 */

import { keccak256 } from "js-sha3";

const STRUCTURAL_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;

/**
 * 校验以太坊地址：
 * 1. 必须满足 `0x` + 40 位十六进制的结构性格式（与 DB CHECK 一致）。
 * 2. 若地址是纯小写或纯大写十六进制（不含大小写混合），视为"未携带校验和信息"，
 *    按 EIP-55 惯例直接放行（这是钱包工具生成全小写地址的常见合法形式）。
 * 3. 若地址大小写混合，必须与按 EIP-55 算法计算出的校验和地址完全一致，否则判定
 *    为大小写错误（可能是用户输入错误或篡改），拒绝写入，避免后续合约交互解析成
 *    另一个地址。
 */
export function isValidEthereumAddress(address: string): boolean {
  if (!STRUCTURAL_ADDRESS_PATTERN.test(address)) {
    return false;
  }

  const hexPart = address.slice(2);
  const isAllLower = hexPart === hexPart.toLowerCase();
  const isAllUpper = hexPart === hexPart.toUpperCase();
  if (isAllLower || isAllUpper) {
    return true;
  }

  return address === toChecksumAddress(address);
}

/** 按 EIP-55 算法计算给定地址的标准大小写校验和形式（输入不要求已通过校验）。 */
export function toChecksumAddress(address: string): string {
  const hexPart = address.slice(2).toLowerCase();
  const hash = keccak256(hexPart);

  let checksummed = "0x";
  for (let i = 0; i < hexPart.length; i += 1) {
    const char = hexPart[i] as string;
    const hashNibble = Number.parseInt(hash[i] as string, 16);
    checksummed += hashNibble >= 8 ? char.toUpperCase() : char;
  }
  return checksummed;
}
