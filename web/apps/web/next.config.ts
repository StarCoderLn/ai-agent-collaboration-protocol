import "@web/env/web";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	typedRoutes: true,
	reactCompiler: true,
	// 文档和 Agent Lab 都使用 127.0.0.1；Next.js 16 默认只允许 localhost
	// 请求开发资源，不显式放行会导致页面只渲染 HTML、客户端交互无法水合。
	allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
