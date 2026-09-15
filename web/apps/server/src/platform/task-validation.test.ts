import { describe, expect, it } from "vitest";

import {
	inferMatchingTagsFromText,
	MAX_MATCHING_TAG_COUNT,
} from "./matching-tags";
import {
	normalizeTaskTags,
	type TaskDraft,
	type TaskValidationConfig,
	validateTaskDraft,
} from "./task-validation";

const NOW = new Date("2026-08-23T00:00:00.000Z");
const CONFIG: TaskValidationConfig = {
	minExecutionPeriodMs: 30 * 60_000,
	minBudgetMinor: 100n,
	maxBudgetMinor: 1_000_000n,
	forbiddenTags: new Set(["赌博"]),
	attachmentLimit: {
		maxFiles: 3,
		maxFileSizeBytes: 20n * 1_048_576n,
		allowedMimeTypes: new Set(["application/pdf", "image/png"]),
	},
};

function validDraft(overrides: Partial<TaskDraft> = {}): TaskDraft {
	return {
		title: "设计并开发可信的 Agent 市场",
		description:
			"需要完成公开市场列表、筛选、详情和可验证评分展示，并提供响应式布局。",
		acceptanceCriteria: "桌面端与移动端均可使用，筛选结果与查询条件一致。",
		deliverableFormat: "Next.js 源码与测试报告",
		categoryId: "category-code",
		tags: ["Next.js", "Design"],
		pricing: { type: "fixed", amountMinor: 20_000n },
		currency: "USDC",
		deadline: new Date(NOW.getTime() + 31 * 60_000),
		requiredCapability: "产品设计与前端开发",
		attachments: [],
		...overrides,
	};
}

describe("validateTaskDraft", () => {
	it("允许用简短原始需求启动 PRD 澄清，但仍拒绝空说明", () => {
		expect(
			validateTaskDraft(
				validDraft({ description: "开发电商首页" }),
				NOW,
				CONFIG,
			),
		).not.toContainEqual(expect.objectContaining({ field: "description" }));
		expect(
			validateTaskDraft(validDraft({ description: "   " }), NOW, CONFIG),
		).toContainEqual(expect.objectContaining({ code: "DESCRIPTION_REQUIRED" }));
	});

	it("reads the current deadline configuration instead of a hard-coded threshold", () => {
		const draft = validDraft({
			deadline: new Date(NOW.getTime() + 40 * 60_000),
		});
		expect(validateTaskDraft(draft, NOW, CONFIG)).toHaveLength(0);
		const changed = { ...CONFIG, minExecutionPeriodMs: 60 * 60_000 };
		expect(validateTaskDraft(draft, NOW, changed)).toContainEqual(
			expect.objectContaining({ code: "DEADLINE_TOO_SOON" }),
		);
	});

	it("validates fixed/range budgets and forbidden tags", () => {
		const errors = validateTaskDraft(
			validDraft({
				pricing: {
					type: "range",
					minAmountMinor: 50_000n,
					maxAmountMinor: 10_000n,
				},
				tags: ["赌博"],
			}),
			NOW,
			CONFIG,
		);
		expect(errors.map((item) => item.code)).toEqual(
			expect.arrayContaining(["BUDGET_RANGE_INVALID", "FORBIDDEN_TAG"]),
		);
	});

	it("允许发布阶段没有报价，但已有报价仍必须满足资金范围", () => {
		expect(
			validateTaskDraft(validDraft({ pricing: null }), NOW, CONFIG),
		).toHaveLength(0);
		expect(
			validateTaskDraft(
				validDraft({ pricing: { type: "fixed", amountMinor: 50n } }),
				NOW,
				CONFIG,
			),
		).toContainEqual(expect.objectContaining({ code: "BUDGET_OUT_OF_RANGE" }));
	});

	it("bounds custom tag count, length and unsafe delimiters", () => {
		expect(
			validateTaskDraft(
				validDraft({
					tags: Array.from(
						{ length: MAX_MATCHING_TAG_COUNT + 1 },
						(_, index) => `tag-${index}`,
					),
				}),
				NOW,
				CONFIG,
			),
		).toContainEqual(expect.objectContaining({ code: "TAG_COUNT_EXCEEDED" }));
		expect(
			validateTaskDraft(
				validDraft({ tags: ["a".repeat(33), "design,code"] }),
				NOW,
				CONFIG,
			),
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: "TAG_TOO_LONG" }),
				expect.objectContaining({ code: "TAG_INVALID" }),
			]),
		);
	});

	it("rejects ETH because business settlement only supports USDC", () => {
		expect(
			validateTaskDraft(validDraft({ currency: "ETH" }), NOW, CONFIG),
		).toContainEqual(
			expect.objectContaining({
				field: "currency",
				code: "CURRENCY_UNSUPPORTED",
			}),
		);
	});

	it("applies category attachment limits immediately and never permits executables", () => {
		const oversized = validDraft({
			attachments: [
				{
					name: "brief.pdf",
					mimeType: "application/pdf",
					sizeBytes: 21n * 1_048_576n,
					storageRef: "ref-1",
				},
			],
		});
		expect(validateTaskDraft(oversized, NOW, CONFIG)).toContainEqual(
			expect.objectContaining({
				code: "ATTACHMENT_SIZE_EXCEEDED",
				message: expect.stringContaining("20MB"),
			}),
		);
		const changed = {
			...CONFIG,
			attachmentLimit: {
				...CONFIG.attachmentLimit,
				maxFileSizeBytes: 50n * 1_048_576n,
			},
		};
		expect(validateTaskDraft(oversized, NOW, changed)).toHaveLength(0);

		const executable = validDraft({
			attachments: [
				{
					name: "installer.exe",
					mimeType: "image/png",
					sizeBytes: 1_000n,
					storageRef: "ref-2",
				},
			],
		});
		expect(validateTaskDraft(executable, NOW, changed)).toContainEqual(
			expect.objectContaining({ code: "EXECUTABLE_ATTACHMENT_FORBIDDEN" }),
		);
	});
});

it("normalizes synonyms and custom whitespace once while removing duplicates", () => {
	expect(
		normalizeTaskTags(
			[" NextJS ", "next.js", "UI", "RAG   Workflow"],
			new Map([["nextjs", "next.js"]]),
		),
	).toEqual(["next.js", "rag workflow", "ui"]);
});

it("从自然语言识别规范能力，同时避免短英文标签的子串误命中", () => {
	const vocabulary = new Map([
		["nextjs", "next.js"],
		["自动化测试", "testing"],
		["go", "go"],
	]);
	expect(
		inferMatchingTagsFromText("使用 NextJS 并补充自动化测试", vocabulary),
	).toEqual(["next.js", "testing"]);
	expect(
		inferMatchingTagsFromText("Use Google APIs", vocabulary),
	).not.toContain("go");
});
