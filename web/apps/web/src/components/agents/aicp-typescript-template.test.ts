import * as ts from "typescript";
import { describe, expect, it } from "vitest";

import { AICP_TYPESCRIPT_TEMPLATE } from "./aicp-typescript-template";

describe("AICP TypeScript integration template", () => {
	it("是可复制的 HTTP 接入代码，且不要求安装平台 SDK", () => {
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
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain('app.get("/healthz"');
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain('status: "ok"');
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain('app.post("/run"');
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain("myAgent.run");
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain('status: "completed"');
		expect(AICP_TYPESCRIPT_TEMPLATE).toContain("artifacts");
		expect(AICP_TYPESCRIPT_TEMPLATE).not.toContain("@aicp/agent-sdk");
		expect(AICP_TYPESCRIPT_TEMPLATE).not.toContain("createHmac");
	});
});
