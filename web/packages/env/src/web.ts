import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
	client: {
		/**
		 * business-api（2.agent-registration）的基础 URL，用于浏览器端直接调用
		 * `PATCH /api/agents/:id`、`PUT /api/agents/:id/credentials` 等接口。
		 * 项目已选定 Next.js Route Handlers + AWS Lambda，但真实路由尚未装配；前端按
		 * design.md 的接口契约先行对接，路由就绪后无需改动调用方代码。
		 */
		NEXT_PUBLIC_BUSINESS_API_URL: z.string().url(),
	},
	runtimeEnv: {
		NEXT_PUBLIC_BUSINESS_API_URL: process.env.NEXT_PUBLIC_BUSINESS_API_URL,
	},
	emptyStringAsUndefined: true,
});
