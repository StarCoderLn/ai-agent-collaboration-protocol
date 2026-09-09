import { describe, expect, it } from "vitest";

import {
  candidatesForSnapshot,
  createCandidatePoolSnapshot,
  normalizeFoundingArbitrators,
} from "./dao-candidate-pool";

const addresses = (prefix: number, count: number) => Array.from(
  { length: count },
  (_, index) => `0x${(prefix + index).toString(16).padStart(40, "0")}`,
);

describe("DAO candidate pool handoff", () => {
  const founding = addresses(1, 8);

  it("没有配置创始名单时保持原有社区候选行为", () => {
    const community = addresses(101, 3);
    const snapshot = createCandidatePoolSnapshot([], community);
    expect(snapshot.phase).toBe("community");
    expect(candidatesForSnapshot(snapshot, community)).toEqual(community);
  });

  it("社区不足八人时由全部合格创始成员提供后备", () => {
    const community = addresses(101, 7);
    const snapshot = createCandidatePoolSnapshot(founding, community);
    expect(snapshot.phase).toBe("bootstrap");
    expect(candidatesForSnapshot(snapshot, [...community, ...founding])).toEqual([...founding, ...community].sort());
  });

  it("八至十一名社区成员时最多保留五名创始成员", () => {
    const community = addresses(101, 8);
    const snapshot = createCandidatePoolSnapshot(founding, community);
    expect(snapshot.phase).toBe("mixed");
    expect(candidatesForSnapshot(snapshot, [...founding, ...community])).toEqual(
      [...community, ...founding.slice(0, 5)].sort(),
    );
  });

  it("达到十二名社区成员后新案件只使用社区候选", () => {
    const community = addresses(101, 12);
    const snapshot = createCandidatePoolSnapshot(founding, community);
    expect(snapshot.phase).toBe("community");
    expect(candidatesForSnapshot(snapshot, [...founding, ...community])).toEqual(community);
  });

  it("案件快照不会因后来新增社区成员而改变阶段", () => {
    const atOpen = addresses(101, 8);
    const later = addresses(101, 12);
    const snapshot = createCandidatePoolSnapshot(founding, atOpen);
    expect(snapshot.phase).toBe("mixed");
    expect(candidatesForSnapshot(snapshot, [...founding, ...later])).toEqual(
      [...later, ...founding.slice(0, 5)].sort(),
    );
  });

  it("拒绝重复、少于八人或超过上限的创始名单", () => {
    expect(() => normalizeFoundingArbitrators([...founding, founding[0] ?? ""])).toThrow("DAO_FOUNDING_ARBITRATORS_DUPLICATED");
    expect(() => normalizeFoundingArbitrators(founding.slice(0, 7))).toThrow("DAO_FOUNDING_ARBITRATORS_INSUFFICIENT");
    expect(() => normalizeFoundingArbitrators(addresses(1, 65))).toThrow("DAO_FOUNDING_ARBITRATORS_EXCEEDED");
  });
});
