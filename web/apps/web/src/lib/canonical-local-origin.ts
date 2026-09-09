/**
 * 仅修正同一端口上的本地 loopback 别名。生产域名、反向代理和不同端口不属于这个
 * 契约，必须保持原请求不变，避免把 Host 头或部署配置错误扩大成开放重定向。
 */
export function resolveCanonicalLocalOrigin(
	requestHost: string | null,
	configuredUrl: string | undefined,
): string | null {
	if (requestHost === null || configuredUrl === undefined) return null;

	try {
		const requestOrigin = new URL(`http://${requestHost}`);
		const canonicalOrigin = new URL(configuredUrl);
		if (
			requestOrigin.host === canonicalOrigin.host ||
			!isLoopbackHost(requestOrigin.hostname) ||
			!isLoopbackHost(canonicalOrigin.hostname) ||
			requestOrigin.port !== canonicalOrigin.port
		) {
			return null;
		}
		return canonicalOrigin.origin;
	} catch {
		return null;
	}
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1";
}
