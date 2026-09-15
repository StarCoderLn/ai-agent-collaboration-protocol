import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./app";

const port = parsePort(process.env.PORT);

// 本地开发与 Lambda 使用同一个 Hono app；这里只负责绑定端口，不复制任何业务配置。
serve(
	{ fetch: app.fetch, hostname: process.env.HOST ?? "127.0.0.1", port },
	(info) => {
		process.stdout.write(
			`Marketplace API 已监听 http://${info.address}:${info.port}\n`,
		);
	},
);

function parsePort(raw: string | undefined): number {
	if (raw === undefined) return 3100;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1 || value > 65535)
		throw new Error("PORT 必须是 1 到 65535 的整数");
	return value;
}
