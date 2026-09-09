import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import type { ReadyDaoRewards } from "@/lib/api/dao-rewards";
import DaoRewardsCard from "./dao-rewards-card";

const mocks = vi.hoisted(() => ({
	getDaoRewards: vi.fn(),
	markDaoRewardsRead: vi.fn(),
}));
vi.mock("@/lib/api/dao-rewards", () => mocks);
const actor = `0x${"11".repeat(20)}`;
const hash = `0x${"33".repeat(32)}`;
const info: ReadyDaoRewards = {
	status: "ready",
	actorId: actor,
	chainId: "31337",
	poolAddress: `0x${"22".repeat(20)}`,
	caseAddress: `0x${"44".repeat(20)}`,
	ydTokenAddress: `0x${"55".repeat(20)}`,
	decimals: 18,
	pendingMinor: "20000000000000000000",
	paidTotalMinor: "0",
	blockNumber: "9",
	page: 1,
	totalPages: 1,
	unreadCount: 0,
	items: [
		{
			id: "10000000-0000-4000-8000-000000000001",
			sourceId: `0x${"66".repeat(32)}`,
			kind: "arbitration",
			programCode: "arbitration_vote",
			amountMinor: "20000000000000000000",
			status: "submitted",
			txHash: null,
			paidAt: null,
			unread: false,
		},
	],
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.getDaoRewards.mockResolvedValue(info);
	window.history.replaceState(null, "", "/");
});
afterEach(() => {
	cleanup();
});

/** 页面只展示服务器确认的到账记录；不存在手动领取按钮或钱包调用依赖。 */
describe("自动 YD 奖励记录", () => {
	it("待确认不显示已到账，也不要求用户领取或签名", async () => {
		render(<DaoRewardsCard actorId={actor} />);
		expect(await screen.findByText("等待到账确认")).toBeInTheDocument();
		expect(
			screen
				.getByRole("heading", { name: "我的 YD 奖励" })
				.querySelector(".lucide-circle-dollar-sign"),
		).toBeInTheDocument();
		expect(screen.queryByText("已到账")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /领取/ }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "交易记录" }),
		).not.toBeInTheDocument();
	});
	it("确认到账后自动标记当前页已读并移除未读提示", async () => {
		const row = {
			...info.items[0],
			status: "paid",
			unread: true,
			txHash: hash,
			paidAt: "2026-09-06T00:00:00Z",
		};
		mocks.getDaoRewards.mockResolvedValue({
			...info,
			items: [row],
			unreadCount: 1,
			paidTotalMinor: info.pendingMinor,
			pendingMinor: "0",
		});
		mocks.markDaoRewardsRead.mockResolvedValue(undefined);
		render(<DaoRewardsCard actorId={actor} />);
		expect(await screen.findByText("已到账")).toBeInTheDocument();
		expect(screen.getByText("有效仲裁投票奖励")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "交易记录" })).toHaveAttribute(
			"href",
			`/transactions/${hash}?source=dao`,
		);
		await waitFor(() =>
			expect(mocks.markDaoRewardsRead).toHaveBeenCalledWith([row.id]),
		);
		await waitFor(() =>
			expect(screen.queryByLabelText("未读")).not.toBeInTheDocument(),
		);
		expect(
			screen.queryByRole("button", { name: "本页标记已读" }),
		).not.toBeInTheDocument();
	});
	it("自动已读同步失败时保留未读状态并说明会自动重试", async () => {
		const row = {
			...info.items[0],
			status: "paid",
			unread: true,
			txHash: hash,
			paidAt: "2026-09-06T00:00:00Z",
		};
		mocks.getDaoRewards.mockResolvedValue({
			...info,
			items: [row],
			unreadCount: 1,
			paidTotalMinor: info.pendingMinor,
			pendingMinor: "0",
		});
		mocks.markDaoRewardsRead.mockRejectedValue(new Error("offline"));
		render(<DaoRewardsCard actorId={actor} />);
		expect(
			await screen.findByText("已读状态将在连接恢复后自动同步。"),
		).toHaveAttribute("role", "status");
		expect(mocks.markDaoRewardsRead).toHaveBeenCalledWith([row.id]);
		expect(screen.getByLabelText("未读")).toBeInTheDocument();
	});
	it("未启用不编造奖励余额，英文同样说明未启用", async () => {
		mocks.getDaoRewards.mockResolvedValue({ status: "not_enabled" });
		render(
			<LocaleProvider initialLocale="en">
				<DaoRewardsCard actorId={actor} />
			</LocaleProvider>,
		);
		expect(
			await screen.findByText(
				"The rewards campaign is not enabled in this environment.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Received")).not.toBeInTheDocument();
	});
	it("分页读取只请求目标页，接口错误不继续展示旧到账金额", async () => {
		mocks.getDaoRewards.mockResolvedValue({ ...info, totalPages: 2 });
		render(<DaoRewardsCard actorId={actor} />);
		fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
		await waitFor(() =>
			expect(mocks.getDaoRewards).toHaveBeenLastCalledWith(
				expect.any(AbortSignal),
				2,
			),
		);
		mocks.getDaoRewards.mockRejectedValue(new Error("offline"));
		fireEvent.click(screen.getByRole("button", { name: "刷新奖励" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"暂时无法核实奖励状态",
		);
		expect(screen.queryByText("累计到账")).not.toBeInTheDocument();
	});
	it("切页后自动标记新页已读，第一页迟到的响应不会覆盖第二页", async () => {
		let resolveFirstMark: (() => void) | undefined;
		const firstMark = new Promise<void>((resolve) => {
			resolveFirstMark = resolve;
		});
		const firstRow = { ...info.items[0], unread: true };
		const secondRow = {
			...info.items[0],
			id: "10000000-0000-4000-8000-000000000002",
			programCode: "verified_user" as const,
			unread: true,
		};
		mocks.getDaoRewards.mockImplementation(
			(_signal: AbortSignal, requestedPage: number) =>
				Promise.resolve({
					...info,
					page: requestedPage,
					totalPages: 2,
					unreadCount: 2,
					items: [requestedPage === 1 ? firstRow : secondRow],
				}),
		);
		mocks.markDaoRewardsRead
			.mockImplementationOnce(() => firstMark)
			.mockResolvedValueOnce(undefined);
		render(<DaoRewardsCard actorId={actor} />);
		fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
		expect(await screen.findByText("新用户验证奖励")).toBeInTheDocument();
		await waitFor(() =>
			expect(mocks.markDaoRewardsRead).toHaveBeenNthCalledWith(2, [
				secondRow.id,
			]),
		);
		resolveFirstMark?.();
		await waitFor(() =>
			expect(screen.getByText("新用户验证奖励")).toBeInTheDocument(),
		);
		expect(screen.queryByText("有效仲裁投票奖励")).not.toBeInTheDocument();
		expect(screen.getByText("2 / 2")).toBeInTheDocument();
	});
});
