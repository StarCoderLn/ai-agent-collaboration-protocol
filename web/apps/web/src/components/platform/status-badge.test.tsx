import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocaleProvider } from "@/components/i18n/locale-provider";
import { StatusBadge } from "./status-badge";

describe("StatusBadge", () => {
	afterEach(() => cleanup());

	it("英文模式能够展示规划与选人状态，而不是因缺少翻译导致页面崩溃", () => {
		render(
			<LocaleProvider initialLocale="en">
				<StatusBadge status="planning" />
			</LocaleProvider>,
		);

		expect(screen.getByText("Planning & Agent selection")).toBeInTheDocument();
	});
});
