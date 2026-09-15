import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { registerRouteDefinitions } from "./hono-route-adapter";
import { routeDefinitions } from "./routes/registry.generated";

describe("Hono Marketplace API", () => {
	it("挂载全部既有路由并由真实健康端点响应", async () => {
		// 路由数量锁定迁移基线，防止目录生成器漏掉某个深层动态路由却仍然构建成功。
		expect(routeDefinitions).toHaveLength(88);
		const response = await createApp().request(
			"https://marketplace-api.test/api/health",
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("把 Hono 动态参数转换为领域处理器沿用的异步 params 契约", async () => {
		const app = new Hono();
		registerRouteDefinitions(app, [
			{
				path: "/api/tasks/:id/nodes/:nodeId",
				methods: ["GET"],
				module: {
					GET: async (
						request: Request,
						context: { params: Promise<Record<string, string>> },
					) =>
						Response.json({
							method: request.method,
							params: await context.params,
						}),
				},
			},
		]);
		const response = await app.request(
			"https://marketplace-api.test/api/tasks/task-1/nodes/node-2",
		);
		expect(await response.json()).toEqual({
			method: "GET",
			params: { id: "task-1", nodeId: "node-2" },
		});
	});

	it("未知接口返回稳定 JSON 错误而不是框架默认文本", async () => {
		const response = await createApp().request(
			"https://marketplace-api.test/api/missing",
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error_code: "NOT_FOUND",
			message: "接口不存在",
			retryable: false,
		});
	});
});
