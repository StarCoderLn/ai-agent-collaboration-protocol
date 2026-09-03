"use client";

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useConnection } from "wagmi";

import { useLocale } from "@/components/i18n/locale-provider";
import { subscribeAuthSessionExpired } from "@/lib/wallet/session-expiry";
import {
	connectWalletSession,
	logoutWalletSession,
	restoreWalletSession,
} from "@/lib/wallet/wallet-session";

type WalletSessionState =
	| Readonly<{
			status: "checking" | "disconnected" | "connecting";
			walletAddress: null;
			chainId: null;
			error: null;
	  }>
	| Readonly<{
			status: "connected";
			walletAddress: string;
			chainId: number;
			error: null;
	  }>
	| Readonly<{
			status: "error";
			walletAddress: null;
			chainId: null;
			error: string;
	  }>;

type WalletSessionContextValue = WalletSessionState &
	Readonly<{
		connect(): Promise<void>;
		logout(): Promise<void>;
	}>;
const WalletSessionContext = createContext<WalletSessionContextValue | null>(
	null,
);

export function WalletSessionProvider({ children }: { children: ReactNode }) {
	const { t } = useLocale();
	const connection = useConnection();
	const hadWalletConnection = useRef(false);
	const [state, setState] = useState<WalletSessionState>({
		status: "checking",
		walletAddress: null,
		chainId: null,
		error: null,
	});
	useEffect(() => {
		let active = true;
		restoreWalletSession().then((session) => {
			if (!active) return;
			setState(
				session === null
					? {
							status: "disconnected",
							walletAddress: null,
							chainId: null,
							error: null,
						}
					: {
							status: "connected",
							walletAddress: session.walletAddress,
							chainId: session.chainId,
							error: null,
						},
			);
		});
		return () => {
			active = false;
		};
	}, []);
	useEffect(() => {
		// 受保护接口返回 401 时，服务端会话已经不再可信。必须立即撤下旧钱包身份，
		// 不能继续用 wagmi 的扩展连接状态冒充已经完成 SIWE 登录。
		return subscribeAuthSessionExpired(() => {
			setState({
				status: "error",
				walletAddress: null,
				chainId: null,
				error: t("登录已过期，请重新签名登录"),
			});
		});
	}, [t]);
	useEffect(() => {
		if (connection.status === "connected") {
			hadWalletConnection.current = true;
			if (
				state.status === "connected" &&
				connection.address.toLowerCase() !== state.walletAddress.toLowerCase()
			) {
				setState({
					status: "error",
					walletAddress: null,
					chainId: null,
					error: t("MetaMask 账户已切换，请重新连接并签名登录"),
				});
			}
		} else if (
			connection.status === "disconnected" &&
			hadWalletConnection.current &&
			state.status === "connected"
		) {
			setState({
				status: "error",
				walletAddress: null,
				chainId: null,
				error: t("MetaMask 已断开，请重新连接并签名登录"),
			});
		}
	}, [connection.address, connection.status, state, t]);
	const connect = useCallback(async () => {
		// 已认证会话再次调用 connect 必须是无操作；账户操作由顶部账户菜单承载，
		// 不能因为普通点击就覆盖现有会话或再次弹出 SIWE 签名。
		if (
			state.status === "connected" ||
			state.status === "connecting" ||
			state.status === "checking"
		)
			return;
		setState({
			status: "connecting",
			walletAddress: null,
			chainId: null,
			error: null,
		});
		try {
			const session = await connectWalletSession();
			setState({
				status: "connected",
				walletAddress: session.walletAddress,
				chainId: session.chainId,
				error: null,
			});
		} catch (error) {
			setState({
				status: "error",
				walletAddress: null,
				chainId: null,
				error: error instanceof Error ? error.message : t("钱包连接失败"),
			});
		}
	}, [state.status, t]);
	const logout = useCallback(async () => {
		if (state.status !== "connected") return;
		// 请求失败时保留当前已认证状态，不能只清前端状态后伪装成安全退出。
		await logoutWalletSession();
		setState({
			status: "disconnected",
			walletAddress: null,
			chainId: null,
			error: null,
		});
	}, [state.status]);
	const value = useMemo(
		() => ({ ...state, connect, logout }),
		[state, connect, logout],
	);
	return (
		<WalletSessionContext.Provider value={value}>
			{children}
		</WalletSessionContext.Provider>
	);
}

export function useWalletSession(): WalletSessionContextValue {
	const value = useContext(WalletSessionContext);
	if (value === null)
		throw new Error("useWalletSession 必须在 WalletSessionProvider 内调用");
	return value;
}
