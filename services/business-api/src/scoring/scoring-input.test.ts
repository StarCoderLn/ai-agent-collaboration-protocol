import { describe, expect, it } from "vitest";

import { parseRatingInput } from "./scoring-input";

describe("rating input boundary", () => {
  it("accepts only publisher-owned quality and communication feedback", () => {
    expect(parseRatingInput({ quality: 5, communication: 4 })).toMatchObject({
      success: true,
      data: { quality: 5, communication: 4 },
    });
  });

  it("rejects response time and system-computed reputation fields", () => {
    expect(parseRatingInput({ quality: 5, communication: 4, timeliness: 5 })).toMatchObject({ success: false });
    expect(parseRatingInput({ quality: 5, communication: 4, disputeRate: 0 })).toMatchObject({ success: false });
    expect(parseRatingInput({ quality: 5, communication: 4, completedScale: 99 })).toMatchObject({ success: false });
  });
});
