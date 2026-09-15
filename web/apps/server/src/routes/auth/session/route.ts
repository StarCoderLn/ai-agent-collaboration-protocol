import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "@server/auth/siwe-config";
import {
	createProductionAuthLogoutDeps,
	createProductionResolveActorId,
} from "@server/http/auth-production-deps";
import {
	createAuthLogoutHandler,
	createAuthSessionHandler,
} from "@server/http/auth-session-handler";
import { handleCorsPreflight } from "@server/http/cors";

let handler: ReturnType<typeof createAuthSessionHandler> | undefined;
let logoutHandler: ReturnType<typeof createAuthLogoutHandler> | undefined;
function getHandler() {
	const config = loadSiweConfigFromEnv();
	return (handler ??= createAuthSessionHandler({
		resolveActorId: createProductionResolveActorId(),
		allowedOrigin: corsOriginFromSiweConfig(config),
		// 会话恢复与 nonce 签名必须引用同一份服务端链配置，避免 Header 展示的
		// 交易网络与用户真正签名、托管时使用的网络发生漂移。
		chainId: config.expectedChainId,
	}));
}
export function GET(request: Request): Promise<Response> {
	return getHandler()(request);
}
export function DELETE(request: Request): Promise<Response> {
	return (logoutHandler ??= createAuthLogoutHandler(
		createProductionAuthLogoutDeps(),
	))(request);
}
export function OPTIONS(): Response {
	return handleCorsPreflight(
		corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
		"GET, DELETE, OPTIONS",
	);
}
