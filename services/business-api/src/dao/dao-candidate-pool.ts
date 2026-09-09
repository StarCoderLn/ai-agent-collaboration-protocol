import { getAddress } from "ethers";
import { z } from "zod";

export const FOUNDING_MIXED_THRESHOLD = 8;
export const COMMUNITY_HANDOFF_THRESHOLD = 12;
export const MIXED_FOUNDING_LIMIT = 5;

const addressSchema = z.string().regex(/^0x[0-9a-f]{40}$/);
const candidatePoolSnapshotSchema = z.object({
  version: z.literal("founding-handoff-v1"),
  phase: z.enum(["bootstrap", "mixed", "community"]),
  foundingArbitrators: z.array(addressSchema).max(64),
  communityEligibleAtOpen: z.number().int().nonnegative(),
  mixedThreshold: z.literal(FOUNDING_MIXED_THRESHOLD),
  handoffThreshold: z.literal(COMMUNITY_HANDOFF_THRESHOLD),
  mixedFoundingLimit: z.literal(MIXED_FOUNDING_LIMIT),
}).strict();

export type CandidatePoolSnapshot = z.infer<typeof candidatePoolSnapshotSchema>;

/**
 * 创始成员名单属于部署级准入配置，而不是管理员逐案选择。名单一旦随案件固化，后续
 * 调整环境变量也不会改变已经进入证据期或申诉期的案件候选来源。
 */
export function normalizeFoundingArbitrators(values: readonly string[]): readonly string[] {
  const normalized = values.map((value) => getAddress(value).toLowerCase());
  const unique = [...new Set(normalized)].sort();
  if (unique.length !== normalized.length) throw new Error("DAO_FOUNDING_ARBITRATORS_DUPLICATED");
  if (unique.length !== 0 && unique.length < 8) throw new Error("DAO_FOUNDING_ARBITRATORS_INSUFFICIENT");
  if (unique.length > 64) throw new Error("DAO_FOUNDING_ARBITRATORS_EXCEEDED");
  return unique;
}

/**
 * 过渡阶段只在开案时由已同步的社区资格数量决定。零创始名单表示部署未启用启动期，
 * 此时保持原有社区候选行为，避免旧部署因新增配置能力被意外切换成空候选池。
 */
export function createCandidatePoolSnapshot(
  foundingArbitrators: readonly string[],
  eligibleMembers: readonly string[],
): CandidatePoolSnapshot {
  const founding = normalizeFoundingArbitrators(foundingArbitrators);
  const foundingSet = new Set(founding);
  const communityEligibleAtOpen = new Set(
    eligibleMembers.map((value) => getAddress(value).toLowerCase()).filter((value) => !foundingSet.has(value)),
  ).size;
  const phase = founding.length === 0 || communityEligibleAtOpen >= COMMUNITY_HANDOFF_THRESHOLD
    ? "community"
    : communityEligibleAtOpen >= FOUNDING_MIXED_THRESHOLD ? "mixed" : "bootstrap";
  return {
    version: "founding-handoff-v1",
    phase,
    foundingArbitrators: [...founding],
    communityEligibleAtOpen,
    mixedThreshold: FOUNDING_MIXED_THRESHOLD,
    handoffThreshold: COMMUNITY_HANDOFF_THRESHOLD,
    mixedFoundingLimit: MIXED_FOUNDING_LIMIT,
  };
}

/**
 * 链上资格复核完成后再执行候选来源策略。社区阶段完全排除创始成员；混合阶段最多保留
 * 五名按地址确定排序的创始成员；启动阶段允许全部合格成员进入同一次 VRF 抽样。
 */
export function candidatesForSnapshot(raw: unknown, eligibleMembers: readonly string[]): readonly string[] {
  const snapshot = candidatePoolSnapshotSchema.parse(raw);
  const foundingSet = new Set(snapshot.foundingArbitrators);
  const normalized = [...new Set(eligibleMembers.map((value) => getAddress(value).toLowerCase()))].sort();
  const community = normalized.filter((value) => !foundingSet.has(value));
  if (snapshot.phase === "community") return community;
  const founding = normalized.filter((value) => foundingSet.has(value));
  return snapshot.phase === "mixed"
    ? [...community, ...founding.slice(0, snapshot.mixedFoundingLimit)].sort()
    : [...community, ...founding].sort();
}

export function parseCandidatePoolSnapshot(raw: unknown): CandidatePoolSnapshot {
  return candidatePoolSnapshotSchema.parse(raw);
}
