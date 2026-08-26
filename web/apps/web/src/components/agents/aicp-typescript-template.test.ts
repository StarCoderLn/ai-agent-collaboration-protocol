import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { AICP_TYPESCRIPT_TEMPLATE } from "./aicp-typescript-template";

describe("AICP TypeScript integration template", () => {
	it("is syntactically valid TypeScript and contains the required protocol boundaries", () => {
		// 模板以字符串展示，不会被 Web 应用自身的 tsc 编译；这里单独转译它，避免复制按钮
		// 看似正常但用户保存后才发现括号、转义或 TypeScript 语法已经损坏。
		const compiled = ts.transpileModule(AICP_TYPESCRIPT_TEMPLATE, {
			compilerOptions: {
				module: ts.ModuleKind.NodeNext,
				target: ts.ScriptTarget.ES2022,
			},
			reportDiagnostics: true,
		});
		const errors = (compiled.diagnostics ?? []).filter(
			(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
		);

		expect(errors).toEqual([]);
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain("timingSafeEqual");
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain("Idempotency-Key");
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain("/healthz");
	});
});
