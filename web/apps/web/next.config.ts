import "@web/env/web";
import type { NextConfig } from "next";

const localDistDir = process.env.AICP_NEXT_DIST_DIR;

// Next 16 会在 distDir 内持有开发服务器锁。本地完整闭环允许使用独立目录，从而在不
// 终止用户已有 `next dev` 的前提下启动隔离验收环境。只接受项目内相对路径，避免环境
// 变量把构建产物写到仓库外；正常开发与生产构建仍沿用 `.next`。
if (
	localDistDir !== undefined &&
	(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(localDistDir) ||
		localDistDir.split("/").includes(".."))
) {
	throw new Error(
		"AICP_NEXT_DIST_DIR must be a relative path inside the Web project",
	);
}

const nextConfig: NextConfig = {
	typedRoutes: true,
	reactCompiler: true,
	// esbuild 会在运行时选择当前平台的原生二进制。若让 Turbopack 继续遍历它的可选平台
	// 包，会把包内 README 等资源误当成模块；Route Handler 只需通过 Node 原生加载它。
	serverExternalPackages: ["esbuild"],
	// 本地完整体验是用户可见的产品界面，隐藏 Next.js 左下角开发工具浮标；编译与
	// 运行时错误仍会正常显示，不影响开发诊断。
	devIndicators: false,
	...(localDistDir === undefined ? {} : { distDir: localDistDir }),
	// 本地完整体验使用 127.0.0.1；Next.js 16 默认只允许 localhost 请求开发资源，
	// 不显式放行会导致页面只渲染 HTML、客户端交互无法水合。
	allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
