import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
	client: {
		/**
		 * marketplace-api（2.agent-registration）的基础 URL，用于浏览器端直接调用
		 * `PATCH /api/agents/:id`、`PUT /api/agents/:id/credentials` 等接口。
		 * Agent、任务、工作流、钱包和争议等正式 Route Handler 共用同一个服务根地址；
		 * 浏览器客户端不得各自拼接不同环境地址，否则跨源 Cookie 与 CORS 配置会漂移。
		 */
		NEXT_PUBLIC_MARKETPLACE_API_URL: z.string().url(),
	},
	runtimeEnv: {
		NEXT_PUBLIC_MARKETPLACE_API_URL:
			process.env.NEXT_PUBLIC_MARKETPLACE_API_URL,
	},
	emptyStringAsUndefined: true,
});
