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

	it("编译使用平台允许的 next/link 与 next/image 的页面", async () => {
		// 这两个依赖在 SUPPORTED_NEXT_IMPORTS 中被显式允许，页面用了就必须能预览。
		// 它们的桩模块本身用 JSX 书写，若缺少 resolveDir，jsx:"automatic" 注入的
		// react/jsx-runtime 无处解析，会让所有带导航链接的页面稳定预览失败。
		const response = await POST(request(codeArtifact(nextImportsPage)));
		const body = (await response.json()) as {
			html: string;
			verification: { status: string };
		};

		expect(response.status).toBe(200);
		expect(body.verification.status).toBe("passed");
		// 桩模块把 Link/Image 降级为原生 a/img，页面内容仍必须进入预览脚本。
		expect(body.html).toContain("\\u79CB\\u5B63\\u65B0\\u6B3E");
	});

	it("拒绝页面导入未授权的服务端或第三方依赖", async () => {
		const response = await POST(
			request(codeArtifact(`import fs from "node:fs";\n${validPage}`)),
		);
		const body = (await response.json()) as { code: string; message: string };

		expect(response.status).toBe(409);
		expect(body.code).toBe("PREVIEW_IMPORT_NOT_ALLOWED");
		expect(body.message).not.toContain("node:fs");
	});

	it("拒绝把静态设计稿误送入代码编译器", async () => {
		const response = await POST(request(designArtifact()));
		const body = (await response.json()) as { code: string };

		expect(response.status).toBe(422);
		expect(body.code).toBe("PREVIEW_REQUEST_INVALID");
	});
});

const validPage = `"use client";
import { useState } from "react";
import { WalletCards } from "lucide-react";
export default function Page() {
  const [confirmed, setConfirmed] = useState(false);
  return <main className="shell"><section className="panel"><WalletCards /><h1>USDC 托管工作台</h1><button className="primary-action" onClick={() => setConfirmed(true)}>{confirmed ? "已确认" : "确认验收"}</button></section></main>;
}`;

const nextImportsPage = `import Link from "next/link";
import Image from "next/image";
import { ShoppingCart } from "lucide-react";
export default function Page() {
  return <main className="shell"><h1>秋季新款</h1><Image src="/hero.png" alt="hero" /><Link href="/buy" className="btn-primary">立即购买<ShoppingCart size={16} /></Link></main>;
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
		schemaVersion: "design.artifact.v0.4",
		taskId: "task-design-1",
		title: "工作流设计原型",
		direction: "用完整可运行页面表现清晰可信的多 Agent 协作体验。",
		tokens: {
			primaryColor: "#7658FF",
			secondaryColor: "#94A3B8",
			backgroundColor: "#0B1020",
			textColor: "#F8FAFC",
			borderRadius: "16px",
			spacingBase: "8px",
			fontFamily: "system-ui",
		},
		pages: [
			{
				id: "main",
				name: "任务详情",
				purpose: "展示任务与 Agent 执行结果。",
				sections: ["摘要", "产物"],
			},
		],
		components: [
			{
				id: "root",
				name: "任务详情",
				parentId: null,
				responsibility: "承载核心任务体验",
				states: ["默认"],
			},
		],
		interactionRules: ["主要按钮具有悬停和焦点状态"],
		responsiveRules: ["窄屏纵向排列"],
		accessibilityRules: ["使用语义标签"],
		assetPlan: [],
		preview: {
			navigation: null,
			hero: {
				eyebrow: "协作",
				title: "工作流设计原型",
				description: "查看真实页面设计。",
				primaryAction: "开始",
				secondaryAction: null,
			},
			metrics: [],
			sections: [],
		},
		rendererVersion: "aicp-design-renderer.v1",
		renderedScreens: [
			designScreen("desktop", 1_440, 900),
			designScreen("mobile", 390, 844),
		],
		generatedBy: { agentId: "design-direct", strategy: "direct" },
		generatedAt: "2026-08-29T00:00:00.000Z",
	};
}

function designScreen(id: "desktop" | "mobile", width: number, height: number) {
	const openingTag = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`;
	return {
		id,
		label: id === "desktop" ? "桌面端设计稿" : "移动端设计稿",
		viewport: { width, height },
		canvas: { width, height },
		mimeType: "image/svg+xml",
		content: `${openingTag.padEnd(520, " ")}</svg>`,
	};
}
