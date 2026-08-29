/**
 * 浏览器内“服务端会话已经失效”的单一通知边界。
 *
 * 受保护 API 最先看到 401，钱包 Provider 则负责统一撤下已认证身份。这里不保存钱包
 * 地址、Cookie 或错误响应，只同步一个失效事实，避免各页面各自维护一套认证状态。
 */
type AuthSessionExpiredListener = () => void;

const listeners = new Set<AuthSessionExpiredListener>();

/** 受保护 API 确认会话无效后调用；重复的并发 401 只会重复通知，不会产生额外副作用。 */
export function notifyAuthSessionExpired(): void {
	for (const listener of listeners) listener();
}

/** 钱包 Provider 订阅失效事实，并在卸载时通过返回函数解除订阅。 */
export function subscribeAuthSessionExpired(
	listener: AuthSessionExpiredListener,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
