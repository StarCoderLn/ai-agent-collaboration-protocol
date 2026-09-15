import { Hono } from "hono";
import { registerRouteDefinitions } from "./hono-route-adapter";
import { routeDefinitions } from "./routes/registry.generated";

/**
 * 创建无进程级可变状态的 Marketplace API。生产依赖仍由各路由按首次请求惰性装配，因此
 * Lambda 冷启动不会因为缺少请求期配置而执行数据库或链上操作。
 */
export function createApp(): Hono {
	const app = new Hono();
	registerRouteDefinitions(app, routeDefinitions);
	app.notFound(() =>
		Response.json(
			{ error_code: "NOT_FOUND", message: "接口不存在", retryable: false },
			{ status: 404 },
		),
	);
	app.onError(() =>
		Response.json(
			{
				error_code: "INTERNAL_ERROR",
				message: "服务暂不可用",
				retryable: true,
			},
			{ status: 500 },
		),
	);
	return app;
}

export const app = createApp();
