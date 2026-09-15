import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// Hono 路由从不同目录深度引用同一领域模块；测试与 esbuild 必须解析同一别名，避免
		// 生产构建成功而 Vitest 使用另一套模块身份。
		alias: { "@server": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	test: {
		// PostgreSQL 集成测试共享显式传入的 DATABASE_URL，其中资金 worker 会像生产环境一样
		// 从全局 outbox 领取下一项作业。测试文件并行时，一个用例可能合法领取另一个用例的
		// 临时作业，导致结果依赖调度时序；串行文件保留生产领取语义并建立稳定的测试隔离。
		fileParallelism: false,
	},
});
