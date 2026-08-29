import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../../../../src/auth/siwe-config";
import { createProductionResolveActorId } from "../../../../src/http/auth-production-deps";
import { handleCorsPreflight } from "../../../../src/http/cors";
import { createWalletAssetsHandler } from "../../../../src/http/wallet-assets-handler";
import { createProductionWalletAssetsDeps } from "../../../../src/http/wallet-assets-production-deps";

let handler: ReturnType<typeof createWalletAssetsHandler> | undefined;

function getHandler() {
	// 生产依赖延迟到首次请求装配，避免 Next 构建阶段因运行时环境变量尚未注入而失败。
	if (handler === undefined) {
		handler = createWalletAssetsHandler(
			createProductionWalletAssetsDeps(createProductionResolveActorId()),
		);
	}
	return handler;
}

export function GET(request: Request): Promise<Response> {
	return getHandler()(request);
}

export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, OPTIONS",
	);
}
