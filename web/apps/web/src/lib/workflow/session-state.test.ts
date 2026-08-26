import { describe, expect, it } from "vitest";
import {
	readWorkflowSession,
	WORKFLOW_SESSION_STORAGE_KEY,
	writeWorkflowSession,
} from "./session-state";

describe("workflow session state", () => {
	it("round-trips a valid selection through the validated storage boundary", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => values.set(key, value),
		};
		const state = {
			version: 1 as const,
			userRequest: "开发一个可以依次生成 PRD、设计和代码的 Agent 市场。",
			selected: { requirements: "prd-direct" as const, design: null, code: null },
			artifacts: { requirements: null, design: null, code: null },
			accepted: { requirements: false, design: false, code: false },
			activeStep: "requirements" as const,
		};

		expect(writeWorkflowSession(storage, state)).toBe(true);
		expect(readWorkflowSession(storage)).toEqual(state);
	});

	it("rejects a forged accepted state without its validated artifact", () => {
		const forged = JSON.stringify({
			version: 1,
			userRequest: "开发一个可以依次生成 PRD、设计和代码的 Agent 市场。",
			selected: { requirements: "prd-direct", design: null, code: null },
			artifacts: { requirements: null, design: null, code: null },
			accepted: { requirements: true, design: false, code: false },
			activeStep: "design",
		});
		const storage = {
			getItem: (key: string) => key === WORKFLOW_SESSION_STORAGE_KEY ? forged : null,
		};

		expect(readWorkflowSession(storage)).toBeNull();
	});
});
