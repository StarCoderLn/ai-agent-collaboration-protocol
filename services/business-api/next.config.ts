import type { NextConfig } from "next";

/**
 * `services/business-api` 是独立部署的 Next.js API-only 应用（仅 Route Handlers，
 * 无页面），承载方向为 AWS Lambda（见 specs/2.agent-registration/design.md 模块 5、
 * specs/PLAN.md 项目级技术栈决策）。
 *
 * `output: "standalone"` 产出自包含的 `.next/standalone` 运行时（含最小化
 * `node_modules`），并由 `infra/build-lambda.sh` 解析 pnpm 软链接、补齐静态资源后生成
 * AWS Lambda Web Adapter 的 zip 部署目录。
 *
 * 项目已冻结为 LWA + zip + AWS CDK；本文件只声明 Next.js 运行时产物，不复制 CDK、
 * Secrets Manager 或 Function URL 配置。部署契约统一由 `infra/` 承担，避免应用配置和
 * 基础设施代码分别维护两套环境知识。
 */
const nextConfig: NextConfig = {
	output: "standalone",
};

export default nextConfig;
