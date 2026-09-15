import {
	corsOriginFromSiweConfig,
	loadSiweConfigFromEnv,
} from "../auth/siwe-config";
import { loadWalletAssetRegistryFromEnv } from "../platform/wallet-asset-config";
import type { WalletAssetsHttpDeps } from "./wallet-assets-handler";

/** 生产装配只组合已有认证与资产配置边界，不创建数据库之外的额外共享状态。 */
export function createProductionWalletAssetsDeps(
	resolveActorId: WalletAssetsHttpDeps["resolveActorId"],
): WalletAssetsHttpDeps {
	return {
		resolveActorId,
		loadRegistry: loadWalletAssetRegistryFromEnv,
		allowedOrigin: corsOriginFromSiweConfig(loadSiweConfigFromEnv()),
	};
}
