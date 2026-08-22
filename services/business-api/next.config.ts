import type { NextConfig } from "next";

/**
 * `services/business-api` 是独立部署的 Next.js API-only 应用（仅 Route Handlers，
 * 无页面），承载方向为 AWS Lambda（见 specs/2.agent-registration/design.md 模块 5、
 * specs/PLAN.md 项目级技术栈决策）。
 *
 * `output: "standalone"` 产出自包含的 `.next/standalone` 运行时（含最小化
 * `node_modules`），是当前主流 Next.js on Lambda 方案（如 AWS Lambda Web Adapter）
 * 的标准前置条件，不额外引入具体打包/IaC 工具依赖。
 *
 * 具体 Lambda 打包与 IaC 方案（如 AWS Lambda Web Adapter、OpenNext、SST、CDK/SAM）
 * 尚未被 PLAN.md 或 design.md 冻结为项目级决策，属于本 task（T-009，仅搭骨架、不挂载
 * 业务路由）范围之外的后续基础设施任务，需单独确认后再引入相应依赖。
 */
const nextConfig: NextConfig = {
	output: "standalone",
};

export default nextConfig;
