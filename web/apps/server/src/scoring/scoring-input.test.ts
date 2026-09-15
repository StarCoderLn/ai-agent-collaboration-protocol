import { describe, expect, it } from "vitest";

import { parseRatingInput } from "./scoring-input";
import { parseWorkflowFeedbackInput } from "./workflow-feedback-input";

describe("rating input boundary", () => {
	it("accepts only publisher-owned quality and communication feedback", () => {
		expect(parseRatingInput({ quality: 5, communication: 4 })).toMatchObject({
			success: true,
			data: { quality: 5, communication: 4 },
		});
	});

	it("rejects response time and system-computed reputation fields", () => {
		expect(
			parseRatingInput({ quality: 5, communication: 4, timeliness: 5 }),
		).toMatchObject({ success: false });
		expect(
			parseRatingInput({ quality: 5, communication: 4, disputeRate: 0 }),
		).toMatchObject({ success: false });
		expect(
			parseRatingInput({ quality: 5, communication: 4, completedScale: 99 }),
		).toMatchObject({ success: false });
	});
});

describe("workflow feedback input boundary", () => {
	it("接受阶段评分、稳定优点标签和显式训练许可", () => {
		expect(
			parseWorkflowFeedbackInput({
				quality: 5,
				communication: 4,
				comment: "页面还原度高，主要购买路径可以直接体验。",
				strengths: ["design_fidelity", "usability"],
				improvement: "移动端商品卡片可以再紧凑一些。",
				allowModelTraining: true,
			}),
		).toMatchObject({
			success: true,
			data: { quality: 5, allowModelTraining: true },
		});
	});

	it("拒绝重复标签和没有文字来源的训练许可", () => {
		expect(
			parseWorkflowFeedbackInput({
				quality: 5,
				communication: 4,
				strengths: ["efficiency", "efficiency"],
				allowModelTraining: false,
			}),
		).toMatchObject({ success: false });
		expect(
			parseWorkflowFeedbackInput({
				quality: 5,
				communication: 4,
				strengths: [],
				allowModelTraining: true,
			}),
		).toMatchObject({ success: false });
	});
});
