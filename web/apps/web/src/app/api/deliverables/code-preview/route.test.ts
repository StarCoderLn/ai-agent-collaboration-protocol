// @vitest-environment node

import { describe, expect, it } from "vitest";

import { POST } from "./route";

describe("POST /api/deliverables/code-preview", () => {
	it("把受控 React 页面编译成无网络权限的隔离预览文档", async () => {
		const response = await POST(request(codeArtifact(validPage)));
		const body = (await response.json()) as {
			html: string;
			verification: { status: string; entryFile: string; fileCount: number };
		};

		expect(response.status).toBe(200);
		expect(body.verification).toEqual({
			compiler: "esbuild",
			status: "passed",
			entryFile: "app/page.tsx",
			fileCount: 2,
		});
		expect(body.html).toContain("connect-src 'none'");
		expect(body.html).toContain('<div id="root"></div>');
		expect(body.html).toContain('type:"ready"');
		expect(body.html).toContain('type:"error"');
		expect(body.html).toContain("USDC 托管工作台");
	});

	it("拒绝页面导入未授权的服务端或第三方依赖", async () => {
		const response = await POST(
			request(codeArtifact('import fs from "node:fs";\n' + validPage)),
		);
		const body = (await response.json()) as { code: string; message: string };

		expect(response.status).toBe(409);
		expect(body.code).toBe("PREVIEW_IMPORT_NOT_ALLOWED");
		expect(body.message).not.toContain("node:fs");
	});

	it("使用同一隔离编译器运行 Design Agent 的 TSX/CSS 原型", async () => {
		const response = await POST(request(designArtifact()));
		const body = (await response.json()) as {
			html: string;
			verification: { status: string; fileCount: number };
		};

		expect(response.status).toBe(200);
		expect(body.verification).toMatchObject({ status: "passed", fileCount: 2 });
		expect(body.html).toContain("工作流设计原型");
		expect(body.html).toContain("#0b1020");
	});
});

const validPage = `"use client";
import { useState } from "react";
import { WalletCards } from "lucide-react";
export default function Page() {
  const [confirmed, setConfirmed] = useState(false);
  return <main className="shell"><section className="panel"><WalletCards /><h1>USDC 托管工作台</h1><button className="primary-action" onClick={() => setConfirmed(true)}>{confirmed ? "已确认" : "确认验收"}</button></section></main>;
}`;

function request(artifact: unknown): Request {
	return new Request("http://localhost/api/deliverables/code-preview", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ artifact }),
	});
}

function codeArtifact(pageSource: string) {
	return {
		schemaVersion: "code.artifact.v0.1",
		taskId: "task-1",
		title: "USDC 托管工作台",
		implementationSummary: "生成可以体验托管状态与验收动作的前端工作台。",
		fileTree: ["app/page.tsx", "app/globals.css"],
		files: [
			{ path: "app/page.tsx", language: "tsx", content: pageSource },
			{
				path: "app/globals.css",
				language: "css",
				content: ".shell{padding:24px}.panel{max-width:960px;margin:auto}",
			},
		],
		runInstructions: ["pnpm dev"],
		testPlan: ["检查主要交互"],
		limitations: ["仅包含前端原型"],
		generatedBy: { agentId: "code-mastra", strategy: "mastra" },
		generatedAt: "2026-08-28T00:00:00.000Z",
	};
}

function designArtifact() {
	return {
		schemaVersion: "design.artifact.v0.3",
		taskId: "task-design-1",
		title: "工作流设计原型",
		direction: "用完整可运行页面表现清晰可信的多 Agent 协作体验。",
		tokens: {
			primaryColor: "#7658FF", secondaryColor: "#94A3B8",
			backgroundColor: "#0B1020", textColor: "#F8FAFC",
			borderRadius: "16px", spacingBase: "8px", fontFamily: "system-ui",
		},
		pages: [{ id: "main", name: "任务详情", purpose: "展示任务与 Agent 执行结果。", sections: ["摘要", "产物"] }],
		components: [{ id: "root", name: "任务详情", parentId: null, responsibility: "承载核心任务体验", states: ["默认"] }],
		interactionRules: ["主要按钮具有悬停和焦点状态"],
		responsiveRules: ["窄屏纵向排列"],
		accessibilityRules: ["使用语义标签"],
		assetPlan: [],
		preview: {
			navigation: null,
			hero: { eyebrow: "协作", title: "工作流设计原型", description: "查看真实页面设计。", primaryAction: "开始", secondaryAction: null },
			metrics: [], sections: [],
		},
		prototype: {
			pageTsx: "// Design Agent 输出完整页面，平台直接编译它而不是再次套用固定展示模板。\n// 四个稳定锚点会继续传给 Coding Agent，用于自动验证视觉结构没有被重新设计。\nexport default function Page(){return <main data-design-id=\"page-shell\"><header data-design-id=\"task-header\"><h1>工作流设计原型</h1></header><section data-design-id=\"summary-panel\">任务摘要</section><section data-design-id=\"artifact-panel\"><button>查看产物</button></section></main>}",
			globalsCss: "/* 这是 Design Agent 决定的完整样式，设计预览与 Coding 结果必须共享同一视觉来源。 */\n/* CSS 不包含远程资源，隔离预览无需开放网络权限。 */\n*{box-sizing:border-box}body{margin:0;background:#0b1020;color:#f8fafc;font-family:system-ui}main{min-height:100vh;padding:48px}header,section{max-width:1080px;margin:0 auto 18px;padding:24px;border:1px solid #33406d;border-radius:16px}button{cursor:pointer}",
		},
		generatedBy: { agentId: "design-direct", strategy: "direct" },
		generatedAt: "2026-08-29T00:00:00.000Z",
	};
}
