import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { notifyAuthSessionExpired } from "@/lib/wallet/session-expiry";
import {
	useWalletSession,
	WalletSessionProvider,
} from "./wallet-session-provider";

const mocks = vi.hoisted(() => ({
	connection: {
		status: "connected",
		address: "0x2222222222222222222222222222222222222222",
	},
	restoreWalletSession: vi.fn(async () => ({
		walletAddress: "0x1111111111111111111111111111111111111111",
		chainId: 31_337,
	})),
	connectWalletSession: vi.fn(),
	logoutWalletSession: vi.fn(async () => undefined),
}));

vi.mock("wagmi", () => ({ useConnection: () => mocks.connection }));
vi.mock("@/lib/wallet/wallet-session", () => ({
	restoreWalletSession: mocks.restoreWalletSession,
	connectWalletSession: mocks.connectWalletSession,
	logoutWalletSession: mocks.logoutWalletSession,
}));

describe("WalletSessionProvider", () => {
	beforeEach(() => {
		mocks.connection.status = "connected";
		mocks.connection.address = "0x1111111111111111111111111111111111111111";
	});
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("invalidates the UI session when MetaMask switches away from the SIWE-authenticated account", async () => {
		mocks.connection.address = "0x2222222222222222222222222222222222222222";
		render(
			<WalletSessionProvider>
				<SessionProbe />
			</WalletSessionProvider>,
		);

		expect(
			await screen.findByText("MetaMask 账户已切换，请重新连接并签名登录"),
		).toBeInTheDocument();
		expect(screen.getByText("error")).toBeInTheDocument();
	});

	it("does not request another SIWE signature when connect is called on an authenticated session", async () => {
		render(
			<WalletSessionProvider>
				<SessionProbe />
			</WalletSessionProvider>,
		);
		expect(await screen.findByText("connected")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "connect" }));

		expect(mocks.connectWalletSession).not.toHaveBeenCalled();
		expect(screen.getByText("connected")).toBeInTheDocument();
	});

	it("changes to disconnected only after server logout succeeds", async () => {
		render(
			<WalletSessionProvider>
				<SessionProbe />
			</WalletSessionProvider>,
		);
		expect(await screen.findByText("connected")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "logout" }));

		expect(await screen.findByText("disconnected")).toBeInTheDocument();
		expect(mocks.logoutWalletSession).toHaveBeenCalledTimes(1);
	});

	it("受保护接口报告会话过期后立即撤下已认证钱包状态", async () => {
		render(
			<WalletSessionProvider>
				<SessionProbe />
			</WalletSessionProvider>,
		);
		expect(await screen.findByText("connected")).toBeInTheDocument();

		notifyAuthSessionExpired();

		expect(await screen.findByText("error")).toBeInTheDocument();
		expect(screen.getByText("登录已过期，请重新签名登录")).toBeInTheDocument();
	});
});

function SessionProbe() {
	const session = useWalletSession();
	return (
		<div>
			<span>{session.status}</span>
			<span>{session.status === "connected" ? session.chainId : null}</span>
			<span>{session.error}</span>
			<button type="button" onClick={() => session.connect()}>
				connect
			</button>
			<button type="button" onClick={() => session.logout()}>
				logout
			</button>
		</div>
	);
}
