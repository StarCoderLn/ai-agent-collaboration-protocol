import { AbiCoder, Interface, keccak256, toUtf8Bytes } from "ethers";
import { z } from "zod";

/**
 * 独立案件的唯一链上 ABI 与边界类型。数据库和页面只消费这些已校验状态，不能用旧版
 * 两票即结算的规则重新解释链上投票。版本升级需与 ArbitrationCases.sol 同步契约测试。
 */
export const daoCaseInterface = new Interface([
  "function openCase(bytes32 caseId,bytes32 taskId,address[] parties,address[] excluded,bytes32 initialRoot)",
  "function submitEvidence(bytes32 caseId,bytes32 evidenceId,bytes32 contentHash)",
  "function requestPanel(bytes32 caseId,address[] candidates)",
  "function selectPanel(bytes32 caseId)",
  "function vote(bytes32 caseId,uint16 releaseBps,bytes32 reasoningHash)",
  "function closeRound(bytes32 caseId)",
  "function appeal(bytes32 caseId)",
  "function finalizeUnappealed(bytes32 caseId)",
  "function resolveRecovery(bytes32 caseId,uint16 releaseBps,bytes32 reasoningHash)",
  "function finalizeRecovery(bytes32 caseId)",
  "function enterRecovery(bytes32 caseId)",
  "function claimUsdc()",
  "function caseOf(bytes32) view returns (tuple(bytes32 taskId,bytes32 evidenceRoot,uint8 status,uint8 round,uint64 evidenceDeadline,uint64 deadline,uint16 firstOutcome,uint16 outcome,bool firstHasMajority,address appellant,tuple(uint256 rewardPerVote,uint256 appealBond,uint256 appealFee,uint8 bondPolicy) terms))",
  "function roundOf(bytes32,uint8) view returns (tuple(uint256 requestId,uint256 randomWord,bool fulfilled,bool rewardsClosed,bytes32 candidatesHash,address[] candidates,address[] panel,uint8 votes))",
  "function votes(bytes32,uint8,address) view returns (bool cast,uint16 releaseBps,bytes32 reasoningHash)",
  "function terms() view returns (uint256 rewardPerVote,uint256 appealBond,uint256 appealFee,uint8 bondPolicy)",
  "function timeoutFallbackBps() view returns (uint16)",
  "function recoveryEligibleAt(bytes32) view returns (uint64)",
  "function membership() view returns (address)",
  "function rewards() view returns (address)",
  "function usdc() view returns (address)",
  "function usdcCredit(address) view returns (uint256)",
  "event EvidenceAnchored(bytes32 indexed caseId,bytes32 indexed evidenceId,address indexed submitter,bytes32 contentHash,bytes32 root)",
  "event FinalDecision(bytes32 indexed caseId,uint16 releaseBps,bytes32 evidenceRoot)",
]);

export const chainCaseStatuses = [
  "none", "evidence", "awaiting_panel", "awaiting_randomness", "randomness_ready",
  "voting", "appeal_window", "final", "stalled", "recovery",
] as const;
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const minor = z.string().regex(/^\d+$/);
export const chainCaseSnapshotSchema = z.object({
  status: z.enum(chainCaseStatuses),
  taskKey: hash,
  evidenceRoot: hash,
  round: z.number().int().min(0).max(2),
  evidenceDeadline: minor,
  deadline: minor,
  releaseBasisPoints: z.number().int().min(0).max(10_000),
  firstReleaseBasisPoints: z.number().int().min(0).max(10_000),
  appellant: address,
  rewardPerVoteMinor: minor,
  appealBondMinor: minor,
  appealFeeMinor: minor,
  bondPolicy: z.number().int().min(0).max(2),
  timeoutFallbackBasisPoints: z.number().int().min(0).max(10_000).nullable().optional(),
  recoveryEligibleAt: minor.nullable().optional(),
  requestId: minor,
  candidatesHash: hash,
  panel: z.array(address).max(5),
  firstPanel: z.array(address).max(3),
  voteCount: z.number().int().min(0).max(5),
  voters: z.array(address).max(5),
  blockNumber: minor,
  blockHash: hash,
  blockTimestamp: minor,
});
export type ChainCaseSnapshot = z.infer<typeof chainCaseSnapshotSchema>;

/** 域分离的案件/证据键不会与 taskKey 编码混用，同一 UUID 在不同用途下得到不同 bytes32。 */
export function daoCaseKey(id: string): string {
  if (!z.uuid().safeParse(id).success) throw new Error("INVALID_DISPUTE_ID");
  return keccak256(toUtf8Bytes(`aicp:arbitration:case:v1:${id.toLowerCase()}`));
}
export function daoEvidenceKey(id: string): string {
  if (!z.uuid().safeParse(id).success) throw new Error("INVALID_EVIDENCE_ID");
  return keccak256(toUtf8Bytes(`aicp:arbitration:evidence:v1:${id.toLowerCase()}`));
}

/**
 * 证据正文先规范化为确定字段序列再计算承诺。附件当前只有引用与元数据，不能声称验证
 * 了远端文件字节；若未来加入文件摘要，需要提升 manifest 版本而非修改已有证据哈希。
 */
export function evidenceContentHash(input: Readonly<{
  disputeId: string; evidenceId: string; submitter: string; description: string; attachments: unknown;
}>): string {
  const submitter = address.parse(input.submitter.toLowerCase());
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["string", "bytes32", "bytes32", "address", "bytes32", "bytes32"],
    ["aicp-evidence-text-and-references-v1", daoCaseKey(input.disputeId), daoEvidenceKey(input.evidenceId),
      submitter, keccak256(toUtf8Bytes(input.description)), keccak256(toUtf8Bytes(canonicalJson(input.attachments)))],
  ));
}

/** JSONB 会重新排序对象字段；递归稳定排序保证从数据库重新读取后还能复算同一个哈希。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error("INVALID_EVIDENCE_JSON");
}
