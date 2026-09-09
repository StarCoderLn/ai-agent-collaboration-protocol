import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadyDaoRewards } from "@/lib/api/dao-rewards";
import DaoRewardNotice from "./dao-reward-notice";

const mocks = vi.hoisted(() => ({
	getDaoRewards: vi.fn(),
	readContract: vi.fn(),
	success: vi.fn(),
	info: vi.fn(),
}));
vi.mock("@/lib/api/dao-rewards", () => ({
	getDaoRewards: mocks.getDaoRewards,
}));
vi.mock("wagmi/actions", () => ({ readContract: mocks.readContract }));
vi.mock("sonner", () => ({
	toast: { success: mocks.success, info: mocks.info },
}));
const actor = `0x${"11".repeat(20)}`;
const paid = {
	id: "reward-1",
	status: "paid",
	unread: true,
	amountMinor: "20000000000000000000",
};
function rewards(overrides: Partial<ReadyDaoRewards> = {}): ReadyDaoRewards {
	return {
		status: "ready",
		actorId: actor,
		chainId: "31337",
		poolAddress: `0x${"22".repeat(20)}`,
		caseAddress: `0x${"33".repeat(20)}`,
		ydTokenAddress: `0x${"44".repeat(20)}`,
		decimals: 18,
		pendingMinor: "0",
		paidTotalMinor: paid.amountMinor,
		blockNumber: "100",
		page: 1,
		totalPages: 1,
		unreadCount: 1,
		items: [],
		...overrides,
	};
}
async function poll() {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(30_000);
	});
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	mocks.readContract.mockResolvedValue(BigInt(0));
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

/** 后端已到账记录才触发提醒：重播、语言变化或普通页面轮询均不能重复弹成功通知。 */
describe("全站 YD 到账提醒", () => {
	it("暂时读到较小总额后恢复不会重复提示，最小单位的新增金额保持精确", async () => {
		mocks.getDaoRewards.mockResolvedValue(rewards());
		render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		mocks.getDaoRewards.mockResolvedValue(rewards({ paidTotalMinor: "0" }));
		await poll();
		mocks.getDaoRewards.mockResolvedValue(rewards());
		await poll();
		expect(mocks.success).not.toHaveBeenCalled();
		mocks.getDaoRewards.mockResolvedValue(
			rewards({ paidTotalMinor: "20000000000000000001" }),
		);
		await poll();
		expect(mocks.success).toHaveBeenCalledWith(
			"0.000000000000000001 YD 奖励已到账",
			expect.any(Object),
		);
	});
	it("第二页旧奖励延迟到账时，即使首页不变且其他设备已读仍提示差额", async () => {
		mocks.getDaoRewards.mockResolvedValue(rewards({ totalPages: 2 }));
		render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		expect(mocks.success).not.toHaveBeenCalled();
		mocks.getDaoRewards.mockResolvedValue(
			rewards({
				totalPages: 2,
				unreadCount: 0,
				paidTotalMinor: "23000000000000000000",
			}),
		);
		await poll();
		expect(mocks.success).toHaveBeenCalledWith(
			"3 YD 奖励已到账",
			expect.any(Object),
		);
		expect(mocks.getDaoRewards).toHaveBeenCalledTimes(2);
		expect(mocks.getDaoRewards).toHaveBeenLastCalledWith(
			expect.any(AbortSignal),
		);
	});
	it("超过十笔批量到账汇总所有分页金额，不只合计首页", async () => {
		mocks.getDaoRewards.mockResolvedValue(rewards({ paidTotalMinor: "0" }));
		render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		mocks.getDaoRewards.mockResolvedValue({
			...rewards({
				totalPages: 2,
				unreadCount: 12,
				paidTotalMinor: "240000000000000000000",
			}),
			items: Array.from({ length: 10 }, (_, index) => ({
				...paid,
				id: `reward-${index}`,
			})),
		});
		await poll();
		expect(mocks.success).toHaveBeenCalledWith(
			"240 YD 奖励已到账",
			expect.any(Object),
		);
	});
	it.each([
		{ actorId: `0x${"55".repeat(20)}` },
		{ poolAddress: `0x${"88".repeat(20)}` },
		{ chainId: "11155111" },
	])("切换奖励范围 %j 时只建立新基线", async (scope) => {
		mocks.getDaoRewards.mockResolvedValue(rewards());
		const view = render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		mocks.getDaoRewards.mockResolvedValue({
			...rewards({ ...scope, paidTotalMinor: "100000000000000000000" }),
			items: [{ ...paid, id: "reward-new-scope" }],
		});
		view.rerender(<DaoRewardNotice actorId={scope.actorId ?? actor} />);
		await poll();
		expect(mocks.success).not.toHaveBeenCalled();
		mocks.getDaoRewards.mockResolvedValue(
			rewards({ ...scope, paidTotalMinor: "101000000000000000000" }),
		);
		await poll();
		expect(mocks.success).toHaveBeenCalledWith(
			"1 YD 奖励已到账",
			expect.any(Object),
		);
	});
	it("从未启用恢复只建立历史金额基线", async () => {
		mocks.getDaoRewards.mockResolvedValue(rewards());
		render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		mocks.getDaoRewards.mockResolvedValue({ status: "not_enabled" });
		await poll();
		expect(screen.getByRole("link", { name: "YD 奖励" })).toHaveAttribute(
			"href",
			"/workspace/rewards",
		);
		mocks.getDaoRewards.mockResolvedValue({
			...rewards({ paidTotalMinor: "40000000000000000000" }),
			items: [{ ...paid, id: "reward-restored" }],
		});
		await poll();
		expect(mocks.success).not.toHaveBeenCalled();
	});
	it("确认服务因重组或网络故障中断后保留原金额基线", async () => {
		mocks.getDaoRewards.mockResolvedValue(rewards());
		render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		mocks.getDaoRewards.mockRejectedValue(
			new Error("REWARD_SYNC_NEEDS_REVIEW"),
		);
		await poll();
		expect(
			screen.getByRole("link", { name: "YD 奖励，1 笔新到账" }),
		).toBeInTheDocument();
		mocks.getDaoRewards.mockResolvedValue(
			rewards({ paidTotalMinor: "22000000000000000000" }),
		);
		await poll();
		expect(mocks.success).toHaveBeenCalledWith(
			"2 YD 奖励已到账",
			expect.any(Object),
		);
	});
	it("首次只显示历史未读数，之后新到账弹一次，重复轮询不重复提醒", async () => {
		mocks.getDaoRewards.mockResolvedValue({
			...rewards({ paidTotalMinor: "0" }),
			status: "ready",
			actorId: actor,
			unreadCount: 0,
			items: [],
		});
		render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		expect(mocks.success).not.toHaveBeenCalled();
		mocks.getDaoRewards.mockResolvedValue({
			...rewards(),
			status: "ready",
			actorId: actor,
			unreadCount: 1,
			items: [paid],
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30000);
		});
		expect(mocks.success).toHaveBeenCalledWith(
			"20 YD 奖励已到账",
			expect.any(Object),
		);
		expect(
			screen
				.getByRole("link", { name: "YD 奖励，1 笔新到账" })
				.querySelector(".lucide-circle-dollar-sign"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "YD 奖励，1 笔新到账" }),
		).toHaveAttribute("href", "/workspace/rewards");
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30000);
		});
		expect(mocks.success).toHaveBeenCalledTimes(1);
		mocks.getDaoRewards.mockResolvedValue({
			...rewards(),
			status: "ready",
			actorId: actor,
			unreadCount: 0,
			items: [{ ...paid, unread: false }],
		});
		await act(async () => {
			window.dispatchEvent(new Event("aicp:rewards-read"));
		});
		expect(screen.getByRole("link", { name: "YD 奖励" })).toBeInTheDocument();
	});
	it("未启用仍保留奖励入口，待发放不能触发成功提示", async () => {
		mocks.getDaoRewards.mockResolvedValue({ status: "not_enabled" });
		render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		expect(screen.getByRole("link", { name: "YD 奖励" })).toHaveAttribute(
			"href",
			"/workspace/rewards",
		);
		mocks.getDaoRewards.mockResolvedValue({
			...rewards({ paidTotalMinor: "0" }),
			status: "ready",
			actorId: actor,
			unreadCount: 0,
			items: [{ ...paid, status: "submitted", unread: false }],
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30000);
		});
		expect(mocks.success).not.toHaveBeenCalled();
		expect(screen.getByRole("link", { name: "YD 奖励" })).toBeInTheDocument();
	});
	it("当前钱包有待领取申诉保证金时只给文字提示，奖励入口保持常驻", async () => {
		mocks.getDaoRewards.mockResolvedValue(
			rewards({ unreadCount: 0, paidTotalMinor: "0" }),
		);
		mocks.readContract.mockResolvedValue(BigInt(1_000_000));
		render(<DaoRewardNotice actorId={actor} />);
		await act(async () => {});
		expect(screen.getByRole("link", { name: "YD 奖励" })).toBeInTheDocument();
		expect(mocks.info).toHaveBeenCalledWith(
			"1 USDC 申诉保证金待领取",
			expect.objectContaining({ id: expect.stringContaining("appeal-bond") }),
		);
	});
});
