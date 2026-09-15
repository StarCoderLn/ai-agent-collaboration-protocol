/**
 * 部署脚手架健康检查端点，用于验证 Hono 应用与 AWS Lambda
 * 运行时可正常启动、响应请求。
 *
 * 这是脚手架基础设施端点，不属于 T-003/T-004/T-005 的业务路由；Agent 档案与
 * SIWE 认证的真实业务路由挂载见 T-010/T-011/T-012。
 */
export function GET(): Response {
	return Response.json({ status: "ok" });
}
