import { z } from "zod";

import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import { MARKETPLACE_API_BASE_URL } from "./base-url";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const assetBaseSchema = z.object({
	assetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
	chainId: z.number().int().positive().safe(),
	symbol: z.string().regex(/^[A-Za-z0-9]{2,12}$/),
	decimals: z.number().int().min(0).max(255),
});
const walletAssetSchema = z.discriminatedUnion("kind", [
	assetBaseSchema.extend({ kind: z.literal("native") }).strict(),
	assetBaseSchema
		.extend({ kind: z.literal("erc20"), address: addressSchema })
		.strict(),
]);
const walletAssetDirectorySchema = z
	.object({
		walletAddress: addressSchema,
		assets: z.array(walletAssetSchema).min(1).max(20),
	})
	.strict()
	.superRefine((value, context) => {
		const assetIds = new Set<string>();
		for (const asset of value.assets) {
			if (assetIds.has(asset.assetId)) {
				context.addIssue({
					code: "custom",
					message: "assetId 必须唯一",
					path: ["assets"],
				});
			}
			assetIds.add(asset.assetId);
		}
	});
const apiErrorSchema = z
	.object({
		error_code: z.string(),
		message: z.string(),
		retryable: z.boolean(),
	})
	.passthrough();

export type WalletAsset = z.infer<typeof walletAssetSchema>;
export type WalletAssetDirectory = z.infer<typeof walletAssetDirectorySchema>;

export class WalletAssetsApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly retryable: boolean,
	) {
		super(message);
		this.name = "WalletAssetsApiError";
	}
}

/** 获取与当前 httpOnly 会话绑定的资产目录；调用方不能传入其他目标钱包地址。 */
export async function getWalletAssetDirectory(
	signal?: AbortSignal,
): Promise<WalletAssetDirectory> {
	let response: Response;
	try {
		response = await fetch(`${MARKETPLACE_API_BASE_URL}/wallet/assets`, {
			credentials: "include",
			cache: "no-store",
			headers: { accept: "application/json" },
			signal,
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === "AbortError")
			throw error;
		throw new WalletAssetsApiError(
			0,
			"WALLET_ASSETS_NETWORK_ERROR",
			"暂时无法连接钱包资产服务",
			true,
		);
	}

	if (response.status === 401) notifyAuthSessionExpired();
	if (!response.ok) throw await responseError(response);
	const parsed = walletAssetDirectorySchema.safeParse(await safeJson(response));
	if (!parsed.success) {
		throw new WalletAssetsApiError(
			response.status,
			"WALLET_ASSETS_INVALID_RESPONSE",
			"钱包资产服务返回的数据格式异常",
			true,
		);
	}
	return parsed.data;
}

async function responseError(
	response: Response,
): Promise<WalletAssetsApiError> {
	const parsed = apiErrorSchema.safeParse(await safeJson(response));
	return parsed.success
		? new WalletAssetsApiError(
				response.status,
				parsed.data.error_code,
				parsed.data.message,
				parsed.data.retryable,
			)
		: new WalletAssetsApiError(
				response.status,
				"WALLET_ASSETS_INVALID_RESPONSE",
				"钱包资产服务返回的数据格式异常",
				true,
			);
}

async function safeJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}
