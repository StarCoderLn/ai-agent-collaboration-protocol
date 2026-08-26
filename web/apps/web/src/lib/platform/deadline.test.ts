import { describe, expect, it } from "vitest";

import {
	deadlineIsoToLocalDate,
	localDateToDeadlineIso,
	parseLocalDate,
} from "./deadline";

describe("task deadline date boundary", () => {
	it("stores a selected local delivery date at the end of that local day", () => {
		const iso = localDateToDeadlineIso("2030-01-20");
		const result = new Date(iso);

		expect(result.getFullYear()).toBe(2030);
		expect(result.getMonth()).toBe(0);
		expect(result.getDate()).toBe(20);
		expect(result.getHours()).toBe(23);
		expect(result.getMinutes()).toBe(59);
		expect(result.getSeconds()).toBe(59);
	});

	it("round-trips an ISO deadline using the current user's calendar date", () => {
		const iso = localDateToDeadlineIso("2030-06-08");
		expect(deadlineIsoToLocalDate(iso)).toBe("2030-06-08");
	});

	it("rejects normalized and impossible dates instead of silently rolling them", () => {
		expect(parseLocalDate("2030-02-30")).toBeNull();
		expect(parseLocalDate("01/20/2030")).toBeNull();
		expect(() => localDateToDeadlineIso("2030-02-30")).toThrow(
			"INVALID_DEADLINE",
		);
	});
});
