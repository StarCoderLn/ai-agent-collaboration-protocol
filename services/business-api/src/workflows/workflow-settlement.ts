import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from "ethers";

export type AcceptedWorkflowSettlementLine = Readonly<{
  nodeId: string;
  acceptanceId: string;
  resultId: string;
  agentId: string;
  payee: string;
  grossAmountMinor: bigint;
  feeAmountMinor: bigint;
  artifactKind: "inline" | "file";
  mimeType: string;
  sizeBytes: bigint;
  bodyOrFileRef: string;
}>;

export type WorkflowSettlementPlan = Readonly<{
  payouts: readonly Readonly<{
    payee: string;
    grossAmountMinor: string;
    feeAmountMinor: string;
  }>[];
  settlementManifestHash: string;
  evidenceRoot: string;
  totalGrossAmountMinor: bigint;
  totalFeeAmountMinor: bigint;
}>;

const coder = AbiCoder.defaultAbiCoder();

/**
 * 把最终验收所覆盖的分账和制品压缩成两份稳定链上摘要。完整正文仍只存在受权限保护的
 * 业务存储中；仲裁时重新按同一编码计算即可证明收款清单或交付引用是否被修改。
 */
export function buildWorkflowSettlementPlan(
  workflowRunId: string,
  lines: readonly AcceptedWorkflowSettlementLine[],
): WorkflowSettlementPlan {
  if (lines.length === 0 || lines.length > 32) throw new Error("WORKFLOW_PAYOUT_COUNT_INVALID");
  const normalized = lines.map((line) => normalizeLine(line));
  const totalGrossAmountMinor = normalized.reduce((sum, line) => sum + line.grossAmountMinor, 0n);
  const totalFeeAmountMinor = normalized.reduce((sum, line) => sum + line.feeAmountMinor, 0n);
  const runHash = textHash(workflowRunId);

  const settlementManifestHash = keccak256(coder.encode(
    ["bytes32", "tuple(bytes32,bytes32,bytes32,address,uint256,uint256)[]"],
    [runHash, normalized.map((line) => [
      textHash(line.nodeId),
      textHash(line.acceptanceId),
      textHash(line.agentId),
      line.payee,
      line.grossAmountMinor,
      line.feeAmountMinor,
    ])],
  ));
  const evidenceRoot = keccak256(coder.encode(
    ["bytes32", "tuple(bytes32,bytes32,bytes32)[]"],
    [runHash, normalized.map((line) => [
      textHash(line.nodeId),
      textHash(line.resultId),
      artifactDigest(line),
    ])],
  ));

  return {
    payouts: normalized.map((line) => ({
      payee: line.payee,
      grossAmountMinor: line.grossAmountMinor.toString(),
      feeAmountMinor: line.feeAmountMinor.toString(),
    })),
    settlementManifestHash,
    evidenceRoot,
    totalGrossAmountMinor,
    totalFeeAmountMinor,
  };
}

function normalizeLine(line: AcceptedWorkflowSettlementLine) {
  // 结算清单进入哈希与合约前先统一地址格式并验证金额。任何零金额、负费用或费用超过
  // 毛额的行都必须在数据库事务内失败，不能留给链上交易以不可读的 revert 拒绝。
  const payee = getAddress(line.payee).toLowerCase();
  if (
    line.grossAmountMinor <= 0n || line.feeAmountMinor < 0n
    || line.feeAmountMinor > line.grossAmountMinor || line.sizeBytes < 0n
    || line.bodyOrFileRef.length === 0
  ) throw new Error("WORKFLOW_PAYOUT_LINE_INVALID");
  return { ...line, payee };
}

function artifactDigest(line: AcceptedWorkflowSettlementLine): string {
  // 文件型制品当前锚定受审计的 storageRef；接入对象存储后应把上传时计算的内容摘要
  // 写入结果事实并替换这里的引用摘要，不能在结算阶段临时下载外部文件。
  return textHash([
    line.artifactKind,
    line.mimeType.toLowerCase(),
    line.sizeBytes.toString(),
    line.bodyOrFileRef,
  ].join("\u0000"));
}

function textHash(value: string): string {
  return keccak256(toUtf8Bytes(value));
}
