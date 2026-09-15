import type { Hono } from "hono";

const SUPPORTED_METHODS = [
	"GET",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
] as const;
type SupportedMethod = (typeof SUPPORTED_METHODS)[number];

/**
 * 迁移前的路由模块已经使用标准 Web Request/Response，只保留了 Next.js 传入 params 的
 * 上下文形状。这个窄接口把该稳定契约接到 Hono，领域处理器无需知道承载框架发生变化。
 */
type RouteHandler = (
	request: Request,
	context: Readonly<{ params: Promise<Record<string, string>> }>,
) => Response | Promise<Response>;

export interface RouteDefinition {
	path: string;
	methods: readonly string[];
	module: Readonly<Record<string, unknown>>;
}

/**
 * 将静态路由表挂到唯一 Hono 应用。方法名和处理器类型只在这个框架边界校验，避免在 87
 * 个业务路由里重复维护适配代码；异常或缺失导出会在服务启动时立即失败。
 */
export function registerRouteDefinitions(
	app: Hono,
	definitions: readonly RouteDefinition[],
): void {
	for (const definition of definitions) {
		for (const rawMethod of definition.methods) {
			if (!isSupportedMethod(rawMethod))
				throw new Error(`不支持的 HTTP 方法：${rawMethod}`);
			const candidate = definition.module[rawMethod];
			if (typeof candidate !== "function")
				throw new Error(`路由 ${definition.path} 缺少 ${rawMethod} 处理器`);
			// 生成器只收集真实导出的函数；断言收敛在唯一不可信模块边界，不向领域层扩散。
			const handler = candidate as RouteHandler;
			app.on(rawMethod, definition.path, (context) =>
				handler(context.req.raw, {
					params: Promise.resolve(context.req.param()),
				}),
			);
		}
	}
}

function isSupportedMethod(method: string): method is SupportedMethod {
	return SUPPORTED_METHODS.some((candidate) => candidate === method);
}
