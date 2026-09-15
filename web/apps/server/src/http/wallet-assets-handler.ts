import { SessionInvalidError } from "../auth/resolve-actor-id";
import type { WalletAssetRegistry } from "../platform/wallet-asset-config";
import { withCredentialedCors } from "./cors";

export interface WalletAssetsHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	loadRegistry(): WalletAssetRegistry;
	allowedOrigin: string;
}

/**
 * 资产目录只返回当前会话钱包和公开链元数据，不代理余额、不接收目标地址。这样调用方
 * 无法借接口批量查询任意地址，浏览器也能用现有 wagmi RPC 直接验证链上结果。
 */
export function createWalletAssetsHandler(deps: WalletAssetsHttpDeps) {
	return async (request: Request): Promise<Response> => {
		try {
			const walletAddress = await deps.resolveActorId(request);
			const registry = deps.loadRegistry();
			const response = Response.json({
				walletAddress,
				assets: registry.assets,
			});
			// 响应含已认证钱包身份，即使链元数据公开也禁止共享缓存保存整份响应。
			response.headers.set("Cache-Control", "private, no-store");
			return withCredentialedCors(response, deps.allowedOrigin);
		} catch (error) {
			const unauthenticated = error instanceof SessionInvalidError;
			const response = Response.json(
				{
					error_code: unauthenticated
						? "UNAUTHENTICATED"
						: "WALLET_ASSETS_UNAVAILABLE",
					message: unauthenticated
						? "请先连接钱包并完成签名登录"
						: "钱包资产配置暂时不可用",
					retryable: !unauthenticated,
				},
				{ status: unauthenticated ? 401 : 503 },
			);
			response.headers.set("Cache-Control", "private, no-store");
			return withCredentialedCors(response, deps.allowedOrigin);
		}
	};
}
