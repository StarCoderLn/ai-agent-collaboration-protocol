"use client";

import { Bot, Boxes, Check, CirclePlus, Copy, LayoutGrid, Loader2, LogOut, Menu, Store, Wallet, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useWalletSession } from "./auth/wallet-session-provider";
import LanguageSwitcher from "./i18n/language-switcher";
import { useLocale } from "./i18n/locale-provider";
import type { MessageId } from "@/lib/i18n/messages";
import BrandMark from "./brand-mark";

const links = [
	{ to: "/tasks", label: "任务市场" as MessageId, icon: LayoutGrid },
	{ to: "/agents", label: "Agent 市场" as MessageId, icon: Store },
	{ to: "/agents/register", label: "上架 Agent" as MessageId, icon: Bot },
	{ to: "/tasks/new", label: "发布任务" as MessageId, icon: CirclePlus },
	{ to: "/workspace", label: "工作台" as MessageId, icon: Boxes },
] as const;

export default function Header() {
	const pathname = usePathname();
	const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
	const wallet = useWalletSession();
	const { t } = useLocale();

	// 客户端路由切换后收起菜单，避免遮挡新页面，也让返回键行为保持直观。
	useEffect(() => { setMobileMenuOpen(false); }, [pathname]);

	return <header className="sticky top-0 z-50 border-b bg-background/80 shadow-[0_12px_40px_rgba(20,8,42,0.08)] backdrop-blur-xl supports-[backdrop-filter]:bg-background/72">
		<div className="mx-auto flex h-17 max-w-360 items-center gap-2 px-4 sm:gap-3 sm:px-6 lg:px-5 xl:px-6">
			<Link href="/" className="flex min-h-11 shrink-0 items-center gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-primary"><BrandMark className="size-10 shrink-0 drop-shadow-[0_0_14px_var(--brand-glow)]" /><span><span className="block font-bold text-[15px] leading-4 tracking-[0.08em]">AICP</span><span className="hidden text-[10px] text-muted-foreground leading-3 2xl:block">{t("Agent 协作网络")}</span></span></Link>
			<nav className="ml-2 hidden min-w-0 flex-1 items-center gap-0.5 xl:flex" aria-label="Main navigation / 主导航">{links.map(({ to, label, icon: Icon }) => { const active = isActivePath(pathname, to); return <Link key={to} href={to} aria-current={active ? "page" : undefined} className={`relative flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-2.5 font-medium text-[13px] transition-[color,background-color] 2xl:px-3 2xl:text-sm ${active ? "text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}><Icon className="size-4" strokeWidth={1.5} aria-hidden />{t(label)}{active && <span className="absolute inset-x-2.5 -bottom-3.5 h-0.5 rounded-full bg-primary shadow-[0_0_12px_var(--primary)] 2xl:inset-x-3" aria-hidden />}</Link>; })}</nav>
			<span className="flex-1 xl:hidden" />
			<LanguageSwitcher />
			<div className="hidden h-6 w-px bg-border sm:block" /><WalletAccountControl wallet={wallet} />
			<button type="button" className="flex size-10 items-center justify-center rounded-lg border bg-card text-foreground xl:hidden" aria-label={mobileMenuOpen ? t("关闭主菜单") : t("打开主菜单")} aria-expanded={mobileMenuOpen} aria-controls="mobile-main-navigation" onClick={() => setMobileMenuOpen((open) => !open)}>{mobileMenuOpen ? <X className="size-5" /> : <Menu className="size-5" />}</button>
		</div>
		{mobileMenuOpen && <nav id="mobile-main-navigation" className="grid grid-cols-2 gap-2 border-t bg-card/95 px-4 py-3 backdrop-blur-xl xl:hidden" aria-label="Mobile navigation / 移动端主导航">{links.map(({ to, label, icon: Icon }) => { const active = isActivePath(pathname, to); return <Link key={to} href={to} aria-current={active ? "page" : undefined} className={`flex min-h-11 items-center gap-2 rounded-lg border px-3 font-medium text-sm ${active ? "border-primary/35 bg-primary-container text-primary" : "bg-background text-muted-foreground"}`}><Icon className="size-4" />{t(label)}</Link>; })}</nav>}
	</header>;
}

function WalletAccountControl({ wallet }: { wallet: ReturnType<typeof useWalletSession> }) {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);
	const [copyDone, setCopyDone] = useState(false);
	const [loggingOut, setLoggingOut] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const closeOnOutsideClick = (event: PointerEvent) => {
			if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", closeOnOutsideClick);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOnOutsideClick);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [open]);

	useEffect(() => {
		if (wallet.status !== "connected") setOpen(false);
	}, [wallet.status]);

	const copyAddress = async () => {
		if (wallet.status !== "connected") return;
		try {
			await navigator.clipboard.writeText(wallet.walletAddress);
			setCopyDone(true);
			setActionError(null);
			window.setTimeout(() => setCopyDone(false), 1_500);
		} catch {
			setActionError(t("复制失败，请手动复制钱包地址"));
		}
	};

	const logout = async () => {
		setLoggingOut(true);
		setActionError(null);
		try {
			await wallet.logout();
			setOpen(false);
		} catch (error) {
			setActionError(error instanceof Error ? error.message : t("退出登录失败，请稍后重试"));
		} finally {
			setLoggingOut(false);
		}
	};

	const connected = wallet.status === "connected";
	const busy = wallet.status === "checking" || wallet.status === "connecting";
	return <div ref={rootRef} className="relative hidden sm:block">
		<button
			type="button"
			className="flex h-10 items-center justify-center gap-1.5 rounded-full border border-primary/20 bg-card/70 px-3 font-medium text-xs shadow-[0_0_18px_var(--brand-glow)]"
			aria-label={connected ? t("打开钱包账户菜单 {address}", { address: wallet.walletAddress }) : t("连接钱包")}
			aria-haspopup={connected ? "menu" : undefined}
			aria-expanded={connected ? open : undefined}
			aria-controls={connected ? "wallet-account-menu" : undefined}
			title={wallet.status === "error" ? wallet.error : undefined}
			onClick={() => connected ? setOpen((current) => !current) : wallet.connect()}
			disabled={busy}
		>
			{busy ? <Loader2 className="size-3.5 animate-spin" /> : <Wallet className="size-3.5 text-secondary" />}
			{connected ? shortAddress(wallet.walletAddress) : t("连接钱包")}
		</button>
		{connected && open && <div id="wallet-account-menu" role="menu" className="surface-elevated absolute right-0 top-[calc(100%+10px)] w-72 overflow-hidden rounded-xl border border-primary/20 p-2 shadow-[0_22px_60px_rgba(0,0,0,0.45)]">
			<div className="border-b px-3 py-2.5">
				<p className="font-semibold text-sm">{t("已连接钱包")}</p>
				<p className="mt-1 truncate font-mono text-muted-foreground text-xs" title={wallet.walletAddress}>{wallet.walletAddress}</p>
			</div>
			<button type="button" role="menuitem" className="mt-1 flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => copyAddress()}>{copyDone ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}{copyDone ? t("地址已复制") : t("复制钱包地址")}</button>
			<button type="button" role="menuitem" className="flex min-h-10 w-full items-center gap-2 rounded-lg px-3 text-left text-destructive text-sm hover:bg-destructive/10" onClick={() => logout()} disabled={loggingOut}>{loggingOut ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}{loggingOut ? t("正在退出") : t("退出登录")}</button>
			{actionError && <p className="mx-3 mb-2 mt-1 text-destructive text-xs leading-5" role="alert">{actionError}</p>}
		</div>}
	</div>;
}

function isActivePath(pathname: string, target: (typeof links)[number]["to"]): boolean {
	if (target === "/tasks" || target === "/agents") return pathname === target;
	return pathname === target || pathname.startsWith(`${target}/`);
}

function shortAddress(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }
