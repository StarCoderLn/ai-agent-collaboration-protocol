import { describe, expect, it } from "vitest";

import { computeAgentScoreSnapshot, computeDisputeRate, validateRatingSubmission, type ScoringRule } from "./scoring";

const NOW = new Date("2026-08-23T00:00:00.000Z");
const RULE: ScoringRule = {
  version: "score-v1",
  priorMean: 3.5,
  priorWeight: 20,
  halfLifeDays: 180,
  recentWindowDays: 90,
  historySaturationScale: 4,
  weights: {
    completionStrength: 1,
    qualityFeedback: 1,
    communicationExperience: 1,
    disputeReliability: 1,
    completedHistory: 0.25,
  },
};

describe("computeAgentScoreSnapshot", () => {
  it("prevents one five-star rating from outranking mature high-quality evidence", () => {
    const newAgent = computeAgentScoreSnapshot({
      ratings: [{ quality: 5, communication: 5, createdAt: NOW }],
      acceptedTaskCount: 1,
      completedTaskCount: 1,
      responseTimes: [{ seconds: 120, respondedAt: NOW }],
      arbitrationOutcomes: [],
    }, RULE, NOW);
    const matureAgent = computeAgentScoreSnapshot({
      ratings: Array.from({ length: 100 }, () => ({ quality: 4, communication: 4, createdAt: NOW })),
      acceptedTaskCount: 100,
      completedTaskCount: 98,
      responseTimes: Array.from({ length: 100 }, () => ({ seconds: 90, respondedAt: NOW })),
      arbitrationOutcomes: ["agent_not_at_fault"],
    }, RULE, NOW);

    expect(newAgent.lowSample).toBe(true);
    expect(matureAgent.lowSample).toBe(false);
    expect(newAgent.dimensions.qualityFeedback.lifetimeValue).toBeLessThan(matureAgent.dimensions.qualityFeedback.lifetimeValue);
    expect(newAgent.score).toBeLessThan(matureAgent.score);
  });

  it("keeps rule version, raw sample size, recent/lifetime values and deterministic output", () => {
    const input = {
      ratings: [
        { quality: 5, communication: 4, createdAt: NOW },
        { quality: 1, communication: 2, createdAt: new Date("2025-01-01T00:00:00.000Z") },
      ],
      acceptedTaskCount: 3,
      completedTaskCount: 2,
      responseTimes: [
        { seconds: 60, respondedAt: NOW },
        { seconds: 600, respondedAt: new Date("2025-01-01T00:00:00.000Z") },
      ],
      arbitrationOutcomes: ["agent_at_fault", "withdrawn"] as const,
    };

    const first = computeAgentScoreSnapshot(input, RULE, NOW);
    const second = computeAgentScoreSnapshot(input, RULE, NOW);
    expect(first).toEqual(second);
    expect(first).toMatchObject({ ruleVersion: "score-v1", sampleSize: 2, disputeRate: 1 });
    expect(first.dimensions.qualityFeedback.recentValue).toBeGreaterThan(first.dimensions.qualityFeedback.lifetimeValue);
    expect(first.systemMetrics.responseTimeSeconds).toEqual({
      recentValue: 60,
      lifetimeValue: 330,
      recentSampleSize: 1,
      lifetimeSampleSize: 2,
    });
  });
});

describe("dispute rate and rating boundary", () => {
  it("does not penalize withdrawn or agent-not-at-fault disputes", () => {
    expect(computeDisputeRate(["withdrawn", "agent_not_at_fault"])).toBe(0);
    expect(computeDisputeRate(["agent_at_fault", "agent_not_at_fault", "withdrawn"])).toBe(0.5);
  });

  it("allows only the publisher to rate a settled task once", () => {
    expect(() => validateRatingSubmission({ actorId: "publisher", publisherId: "publisher", taskStatus: "settled", existingRating: false, quality: 5, communication: 4 })).not.toThrow();
    expect(() => validateRatingSubmission({ actorId: "agent", publisherId: "publisher", taskStatus: "settled", existingRating: false, quality: 5, communication: 4 })).toThrow("RATING_FORBIDDEN");
    expect(() => validateRatingSubmission({ actorId: "publisher", publisherId: "publisher", taskStatus: "settled", existingRating: true, quality: 5, communication: 4 })).toThrow("TASK_ALREADY_RATED");
  });
});
