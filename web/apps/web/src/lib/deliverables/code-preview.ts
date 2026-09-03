import { build, type Plugin } from "esbuild";
import { z } from "zod";

import {
	type CodeArtifact,
	CodeArtifactSchema,
} from "@/lib/workflow/contracts";

const MAX_PREVIEW_REQUEST_BYTES = 120_000;
const MAX_PREVIEW_SOURCE_CHARACTERS = 50_000;
const ALLOWED_PAGE_IMPORTS = new Set(["react", "lucide-react"]);
const SUPPORTED_NEXT_IMPORTS = new Set(["next/link", "next/image"]);
// Agent 常按 Next.js 自动 JSX runtime 书写组件，不会显式 import React。这里只允许 esbuild
// 自动注入 React 官方 runtime；源码边界仍不能直接声明这些内部依赖。
const REACT_RUNTIME_IMPORTS = new Set([
	"react/jsx-runtime",
	"react/jsx-dev-runtime",
]);

const PreviewRequestSchema = z
	.object({ artifact: CodeArtifactSchema })
	.strict()
	.superRefine(({ artifact }, context) => {
		const totalCharacters = artifact.files.reduce(
			(total, file) => total + file.content.length,
			0,
		);
		if (totalCharacters > MAX_PREVIEW_SOURCE_CHARACTERS) {
			context.addIssue({
				code: "custom",
				path: ["artifact", "files"],
				message: "CODE_PREVIEW_SOURCE_TOO_LARGE",
			});
		}
	});

export type CodePreviewCompilation = Readonly<{
	html: string;
	verification: Readonly<{
		compiler: "esbuild";
		status: "passed";
		entryFile: "app/page.tsx";
		fileCount: number;
	}>;
}>;

export class CodePreviewError extends Error {
	constructor(
		readonly code:
			| "PREVIEW_REQUEST_INVALID"
			| "PREVIEW_ENTRY_MISSING"
			| "PREVIEW_IMPORT_NOT_ALLOWED"
			| "PREVIEW_COMPILE_FAILED",
		message: string,
	) {
		super(message);
	}
}

/**
 * 只编译平台已经验证过的单页前端制品，不在服务端执行生成代码。页面源码只能导入 React、
 * lucide-react 以及两个受控 Next.js 组件；相对导入和其他包会在解析阶段被拒绝。编译结果
 * 随后仍须放进无同源权限、无网络权限的 iframe，不能在平台页面上下文中直接执行。
 */
export async function compileCodePreview(
	rawInput: unknown,
): Promise<CodePreviewCompilation> {
	const parsed = PreviewRequestSchema.safeParse(rawInput);
	if (!parsed.success) {
		throw new CodePreviewError(
			"PREVIEW_REQUEST_INVALID",
			"代码制品格式不完整或超过预览大小限制",
		);
	}
	const artifact = parsed.data.artifact;
	const source = previewSource(artifact);
	if (source === null) {
		throw new CodePreviewError(
			"PREVIEW_ENTRY_MISSING",
			"代码制品缺少 app/page.tsx，无法生成网站预览",
		);
	}
	assertPageImportsAllowed(source.pageTsx);

	try {
		const result = await build({
			absWorkingDir: process.cwd(),
			bundle: true,
			define: { "process.env.NODE_ENV": '"production"' },
			entryPoints: ["aicp-preview-entry"],
			format: "iife",
			jsx: "automatic",
			logLevel: "silent",
			minify: false,
			platform: "browser",
			plugins: [previewVirtualFiles(source.pageTsx)],
			target: ["es2022"],
			write: false,
		});
		const script = result.outputFiles[0]?.text;
		if (script === undefined) {
			throw new CodePreviewError(
				"PREVIEW_COMPILE_FAILED",
				"预览编译器没有生成浏览器脚本",
			);
		}
		return {
			html: renderSandboxDocument(artifact, source.globalsCss, script),
			verification: {
				compiler: "esbuild",
				status: "passed",
				entryFile: "app/page.tsx",
				fileCount: source.fileCount,
			},
		};
	} catch (error) {
		if (error instanceof CodePreviewError) throw error;
		const message = error instanceof Error ? error.message : "未知编译错误";
		if (message.includes("PREVIEW_IMPORT_NOT_ALLOWED")) {
			throw new CodePreviewError(
				"PREVIEW_IMPORT_NOT_ALLOWED",
				"页面使用了预览环境未授权的依赖",
			);
		}
		throw new CodePreviewError(
			"PREVIEW_COMPILE_FAILED",
			"页面代码未通过预览编译，请让 Agent 修复后重新提交",
		);
	}
}

/**
 * 代码预览只处理 Coding Agent 的可执行制品。设计阶段已经改为静态 SVG 设计稿，不能
 * 再进入编译器；这条边界避免把“可查看的设计图片”误解为“可执行的应用代码”。
 */
function previewSource(
	artifact: CodeArtifact,
): Readonly<{ pageTsx: string; globalsCss: string; fileCount: number }> | null {
	const page = artifact.files.find((file) => file.path === "app/page.tsx");
	if (page === undefined) return null;
	return {
		pageTsx: page.content,
		globalsCss:
			artifact.files.find((file) => file.path === "app/globals.css")?.content ??
			"html,body,#root{min-height:100%;margin:0}",
		fileCount: artifact.files.length,
	};
}

/**
 * esbuild 会在打包前消除部分未使用导入，因此安全判断不能依赖打包器是否实际解析某个
 * import。这里先检查源码声明，并禁止动态 import/require，确保不可达代码也不能悄悄
 * 携带服务端模块或新的网络依赖。
 */
function assertPageImportsAllowed(source: string): void {
	if (/\b(?:require|import)\s*\(/.test(source)) {
		throw new CodePreviewError(
			"PREVIEW_IMPORT_NOT_ALLOWED",
			"页面使用了预览环境未授权的动态依赖",
		);
	}
	for (const match of source.matchAll(
		/(?:from\s+|import\s*)["']([^"']+)["']/g,
	)) {
		const dependency = match[1];
		if (
			dependency === undefined ||
			(!ALLOWED_PAGE_IMPORTS.has(dependency) &&
				!SUPPORTED_NEXT_IMPORTS.has(dependency))
		) {
			throw new CodePreviewError(
				"PREVIEW_IMPORT_NOT_ALLOWED",
				"页面使用了预览环境未授权的依赖",
			);
		}
	}
}

export function previewRequestIsTooLarge(request: Request): boolean {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	return (
		Number.isFinite(contentLength) && contentLength > MAX_PREVIEW_REQUEST_BYTES
	);
}

function previewVirtualFiles(pageSource: string): Plugin {
	return {
		name: "aicp-code-preview",
		setup(context) {
			context.onResolve({ filter: /^aicp-preview-entry$/ }, () => ({
				path: "entry.tsx",
				namespace: "aicp-preview",
			}));
			context.onResolve({ filter: /^aicp-preview-page$/ }, () => ({
				path: "page.tsx",
				namespace: "aicp-preview",
			}));
			context.onResolve({ filter: /.*/, namespace: "aicp-preview" }, (args) => {
				if (args.path === "aicp-preview-page") {
					return { path: "page.tsx", namespace: "aicp-preview" };
				}
				if (
					args.importer === "entry.tsx" &&
					(args.path === "react" || args.path === "react-dom/client")
				) {
					return undefined;
				}
				if (ALLOWED_PAGE_IMPORTS.has(args.path)) return undefined;
				if (REACT_RUNTIME_IMPORTS.has(args.path)) return undefined;
				if (SUPPORTED_NEXT_IMPORTS.has(args.path)) {
					return { path: args.path, namespace: "aicp-next-stub" };
				}
				throw new Error(`PREVIEW_IMPORT_NOT_ALLOWED:${args.path}`);
			});
			context.onLoad(
				{ filter: /^entry\.tsx$/, namespace: "aicp-preview" },
				() => ({
					loader: "tsx",
					resolveDir: process.cwd(),
					contents: `import React from "react";
import { createRoot } from "react-dom/client";
import Page from "aicp-preview-page";
const root = document.getElementById("root");
if (root === null) throw new Error("PREVIEW_ROOT_MISSING");
createRoot(root).render(React.createElement(Page));`,
				}),
			);
			context.onLoad(
				{ filter: /^page\.tsx$/, namespace: "aicp-preview" },
				() => ({
					loader: "tsx",
					resolveDir: process.cwd(),
					contents: pageSource,
				}),
			);
			// 两个 Next.js 桩模块本身用 JSX 书写，jsx:"automatic" 会为它们注入
			// react/jsx-runtime。缺少 resolveDir 时该注入无处解析，任何使用平台明确允许的
			// next/link 或 next/image 的页面都会编译失败——错误还会被归类成“页面代码有问题”，
			// 把平台自身的装配缺陷说成 Agent 的产物缺陷。
			context.onLoad(
				{ filter: /^next\/link$/, namespace: "aicp-next-stub" },
				() => ({
					loader: "tsx",
					resolveDir: process.cwd(),
					contents: `import React from "react";
export default function Link({ href, children, ...props }) {
  return <a {...props} href={typeof href === "string" ? href : "#"} onClick={(event) => event.preventDefault()}>{children}</a>;
}`,
				}),
			);
			context.onLoad(
				{ filter: /^next\/image$/, namespace: "aicp-next-stub" },
				() => ({
					loader: "tsx",
					resolveDir: process.cwd(),
					contents: `import React from "react";
export default function Image({ src, alt = "", ...props }) { return <img {...props} src={typeof src === "string" ? src : ""} alt={alt} />; }`,
				}),
			);
		},
	};
}

function renderSandboxDocument(
	artifact: CodeArtifact,
	css: string,
	script: string,
): string {
	const title = escapeHtml(artifact.title);
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none';" />
<title>${title}</title>
<style>${escapeStyle(css)}</style>
</head>
<body>
<div id="preview-error" hidden style="margin:24px;padding:16px;border:1px solid #ef4444;border-radius:12px;color:#991b1b;background:#fef2f2;font-family:system-ui,sans-serif"></div>
<div id="root"></div>
<script>
var previewFailed=false;
function reportPreviewError(message){
  previewFailed=true;
  var safeMessage=typeof message==="string"&&message.length>0?message:"未知错误";
  var panel=document.getElementById("preview-error");
  if(panel){panel.hidden=false;panel.textContent="预览运行失败："+safeMessage;}
  window.parent.postMessage({source:"aicp-code-preview",type:"error",message:safeMessage},"*");
}
window.addEventListener("error",function(event){reportPreviewError(event.message);});
window.addEventListener("unhandledrejection",function(event){
  var reason=event.reason;
  reportPreviewError(reason&&typeof reason.message==="string"?reason.message:String(reason||"未知错误"));
});
</script>
<script>${escapeScript(script)}</script>
<script>
// React 的首次绘制可能发生在当前脚本返回之后。连续等待两帧再上报 ready，避免把仅完成
// 编译、但挂载阶段已经失败的页面误判成可验收产物。
requestAnimationFrame(function(){requestAnimationFrame(function(){
  if(!previewFailed){window.parent.postMessage({source:"aicp-code-preview",type:"ready"},"*");}
});});
</script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function escapeStyle(value: string): string {
	return value.replace(/<\/style/gi, "<\\/style");
}

function escapeScript(value: string): string {
	return value.replace(/<\/script/gi, "<\\/script");
}
