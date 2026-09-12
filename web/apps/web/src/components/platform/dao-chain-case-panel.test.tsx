import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleProvider } from "@/components/i18n/locale-provider";
import { type ChainArbitration, inspectDaoEvidence } from "@/lib/api/dao-cases";
import { executeDaoCaseAction } from "@/lib/wallet/dao-case-flow";
import { createDaoEvidenceRecovery } from "@/lib/wallet/dao-evidence-recovery";
import DaoChainCasePanel from "./dao-chain-case-panel";

const actor = `0x${"11".repeat(20)}`;
const walletMock = vi.hoisted(() => ({
	address: `0x${"11".repeat(20)}`,
	credit: vi.fn(),
}));
vi.mock("@/components/auth/wallet-session-provider", () => ({
	useWalletSession: () => ({
		status: "connected",
		walletAddress: walletMock.address,
	}),
}));
vi.mock("@/lib/wallet/dao-case-flow", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/wallet/dao-case-flow")>()),
	executeDaoCaseAction: vi.fn(),
}));
vi.mock("@/lib/api/dao-cases", () => ({
	inspectDaoEvidence: vi.fn(),
}));
vi.mock("wagmi/actions", () => ({ readContract: walletMock.credit }));

/** 验证用户看到真实的资金阶段和费用，而非仅以最终按钮是否存在作为仲裁验收依据。 */
describe("链上仲裁案件侧栏", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		localStorage.clear();
		walletMock.address = actor;
		walletMock.credit.mockResolvedValue(BigInt(0));
	});
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});
	it.each([
		[
			"DAO_CASE_OPERATOR_INSUFFICIENT_FUNDS",
			"案件操作账户缺少 Sepolia ETH 支付 Gas；平台补充后会继续处理，任务资金仍被冻结。",
		],
		[
			"DAO_REWARD_POOL_INSUFFICIENT",
			"仲裁奖励池需要补充 YD 后才能继续处理，任务资金仍被冻结。",
		],
	] as const)("向用户说明可恢复的 %s 原因", (lastErrorCode, message) => {
		render(
			<LocaleProvider initialLocale="zh-CN">
				<DaoChainCasePanel
					disputeId="10000000-0000-4000-8000-000000000001"
					info={{ ...info(), lastErrorCode }}
					evidence={[]}
					onRefresh={vi.fn()}
				/>
			</LocaleProvider>,
		);
		expect(screen.getByRole("status")).toHaveTextContent(message);
	});
	it.each(["zh-CN", "en"] as const)(
		"%s 广播失败后保留原哈希，未经回执核验不能重复签名",
		async (locale) => {
			broadcastThenFail();
			render(
				<LocaleProvider initialLocale={locale}>
					<DaoChainCasePanel
						disputeId="10000000-0000-4000-8000-000000000001"
						info={{ ...info(), status: "evidence" }}
						evidence={[
							{
								id: "10000000-0000-4000-8000-000000000002",
								submittedBy: actor,
								integrity: "consistent",
							},
						]}
						onRefresh={vi.fn()}
					/>
				</LocaleProvider>,
			);
			fireEvent.click(
				screen.getByRole("button", {
					name: locale === "en" ? "Anchor your evidence 1" : "锚定你的证据 1",
				}),
			);
			expect(
				await screen.findByText(
					locale === "en"
						? "Check the original transaction first. Re-signing is available only after every known hash is confirmed reverted; pending or orphaned receipts must keep waiting."
						: "请先核验原交易。只有全部已知哈希都确认回滚后才能重新签名；未确认或孤块回执必须继续等待。",
				),
			).toBeInTheDocument();
			expect(inspectDaoEvidence).not.toHaveBeenCalled();
			expect(executeDaoCaseAction).toHaveBeenCalledTimes(1);
		},
	);
	it("同一挂载切换钱包后，原钱包迟到的广播回调只保存原作用域", async () => {
		const release = vi.fn<() => void>();
		const gate = new Promise<void>((resolve) =>
			release.mockImplementation(resolve),
		);
		vi.mocked(executeDaoCaseAction).mockImplementationOnce(async (input) => {
			await gate;
			input.onBroadcast(`0x${"44".repeat(32)}`);
			throw new Error("等待链上确认超时");
		});
		const view = renderEvidence(vi.fn());
		fireEvent.click(screen.getByRole("button", { name: "锚定你的证据 1" }));
		walletMock.address = `0x${"66".repeat(20)}`;
		view.rerender(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={{ ...info(), status: "evidence" }}
				evidence={[]}
				onRefresh={vi.fn()}
			/>,
		);
		await act(async () => release());
		expect(
			screen.queryByRole("button", { name: "核验交易状态" }),
		).not.toBeInTheDocument();
		view.unmount();
		walletMock.address = actor;
		renderEvidence(vi.fn());
		expect(
			await screen.findByRole("button", { name: "核验交易状态" }),
		).toBeInTheDocument();
	});
	it("刷新重新挂载后恢复交易哈希，只手动同步，成功后清理持久记录", async () => {
		broadcastThenFail();
		const view = renderEvidence(vi.fn());
		fireEvent.click(screen.getByRole("button", { name: "锚定你的证据 1" }));
		await screen.findByRole("button", { name: "核验交易状态" });
		view.unmount();
		const onRefresh = vi.fn();
		const recovered = renderEvidence(onRefresh);
		const retry = await screen.findByRole("button", {
			name: "核验交易状态",
		});
		expect(inspectDaoEvidence).not.toHaveBeenCalled();
		expect(executeDaoCaseAction).toHaveBeenCalledTimes(1);
		vi.mocked(inspectDaoEvidence).mockResolvedValue(anchored());
		fireEvent.click(retry);
		await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
		recovered.unmount();
		renderEvidence(vi.fn());
		expect(
			screen.queryByRole("button", { name: "核验交易状态" }),
		).not.toBeInTheDocument();
	});
	it("两条证据的广播记录互不覆盖，同步一条保留另一条", async () => {
		broadcastThenFail();
		broadcastThenFail(`0x${"55".repeat(32)}`);
		const onRefresh = vi.fn();
		const props = {
			evidence: [
				{
					id: "10000000-0000-4000-8000-000000000002",
					submittedBy: actor,
					integrity: "consistent",
				},
				{
					id: "10000000-0000-4000-8000-000000000003",
					submittedBy: actor,
					integrity: "consistent",
				},
			],
		};
		const view = renderEvidence(onRefresh, props);
		fireEvent.click(screen.getByRole("button", { name: "锚定你的证据 1" }));
		await screen.findByRole("button", { name: "核验交易状态" });
		fireEvent.click(screen.getByRole("button", { name: "锚定你的证据 2" }));
		await waitFor(() =>
			expect(
				screen.getAllByRole("button", { name: "核验交易状态" }),
			).toHaveLength(2),
		);
		view.unmount();
		renderEvidence(onRefresh, props);
		vi.mocked(inspectDaoEvidence).mockResolvedValue(anchored());
		fireEvent.click(
			(await screen.findAllByRole("button", { name: "核验交易状态" }))[0],
		);
		await waitFor(() =>
			expect(
				screen.getAllByRole("button", { name: "核验交易状态" }),
			).toHaveLength(1),
		);
		expect(screen.getByText(`交易：0x${"55".repeat(32)}`)).toBeInTheDocument();
	});
	it.each(["wallet", "case", "chain", "contract"])(
		"恢复记录与 %s 隔离",
		async (changed) => {
			broadcastThenFail();
			const view = renderEvidence(vi.fn());
			fireEvent.click(screen.getByRole("button", { name: "锚定你的证据 1" }));
			await screen.findByRole("button", { name: "核验交易状态" });
			view.unmount();
			if (changed === "wallet") walletMock.address = `0x${"66".repeat(20)}`;
			renderEvidence(vi.fn(), {
				disputeId:
					changed === "case"
						? "10000000-0000-4000-8000-000000000009"
						: "10000000-0000-4000-8000-000000000001",
				info: {
					...info(),
					status: "evidence",
					chainId: changed === "chain" ? "11155111" : "31337",
					contractAddress:
						changed === "contract"
							? `0x${"77".repeat(20)}`
							: info().contractAddress,
				},
			});
			expect(
				screen.queryByRole("button", { name: "核验交易状态" }),
			).not.toBeInTheDocument();
			expect(inspectDaoEvidence).not.toHaveBeenCalled();
		},
	);
	it("申诉失败只显示可操作提示，不泄露 RPC、地址或 calldata", async () => {
		vi.mocked(executeDaoCaseAction).mockRejectedValue(
			new Error(
				"transaction gas limit too high cap: 16777216 tx: 21000000 Request Arguments: to 0x2222222222222222222222222222222222222222 data 0xdeadbeef",
			),
		);
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={info()}
				evidence={[]}
				onRefresh={vi.fn()}
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "确认费用并申诉" }));
		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"钱包给出的 Gas 上限异常，交易尚未发送。请刷新页面后重试。",
		);
		expect(alert).toHaveClass("text-destructive");
		expect(alert).not.toHaveTextContent("16777216");
		expect(alert).not.toHaveTextContent(
			"0x2222222222222222222222222222222222222222",
		);
		expect(alert).not.toHaveTextContent("0xdeadbeef");
	});
	it.each(["malformed", "unknown-evidence"])(
		"忽略不可信恢复记录 %s，不伪造已锚定状态",
		async (invalid) => {
			broadcastThenFail();
			const view = renderEvidence(vi.fn());
			fireEvent.click(screen.getByRole("button", { name: "锚定你的证据 1" }));
			await screen.findByRole("button", { name: "核验交易状态" });
			view.unmount();
			const key = Object.keys(localStorage).find((value) =>
				value.startsWith("aicp:dao-evidence:"),
			);
			expect(key).toBeDefined();
			if (key === undefined) throw new Error("未保存恢复记录");
			localStorage.removeItem(key);
			localStorage.setItem(
				invalid === "malformed"
					? key
					: key.replace("000000000002:", "000000000009:"),
				invalid === "malformed"
					? "not-json"
					: JSON.stringify({
							evidenceId: "10000000-0000-4000-8000-000000000009",
							txHash: `0x${"44".repeat(32)}`,
						}),
			);
			renderEvidence(vi.fn());
			expect(
				screen.queryByRole("button", { name: "核验交易状态" }),
			).not.toBeInTheDocument();
			expect(inspectDaoEvidence).not.toHaveBeenCalled();
		},
	);
	it("持久存储不可用仍保留内存哈希、复制入口与恢复说明", async () => {
		const copy = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal("navigator", { clipboard: { writeText: copy } });
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		broadcastThenFail();
		renderEvidence(vi.fn());
		fireEvent.click(screen.getByRole("button", { name: "锚定你的证据 1" }));
		expect(
			await screen.findByRole("button", { name: "核验交易状态" }),
		).toBeInTheDocument();
		expect(screen.getByText(/浏览器无法保存恢复记录/)).toBeInTheDocument();
		expect(screen.getByText(`交易：0x${"44".repeat(32)}`)).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "复制交易哈希" }),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "复制交易哈希" }));
		await waitFor(() =>
			expect(copy).toHaveBeenCalledWith(`0x${"44".repeat(32)}`),
		);
	});
	it("保证金政策未配置时不把维持原裁决扣款表述为已确定条款", () => {
		const value = info();
		if (value.snapshot === null) throw new Error("缺少测试快照");
		renderEvidence(vi.fn(), {
			info: { ...value, snapshot: { ...value.snapshot, bondPolicy: 0 } },
		});
		expect(
			screen.getByText("保证金退还政策尚未配置，暂不能申诉。"),
		).toBeInTheDocument();
		expect(screen.queryByText(/维持原裁决则转入/)).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "确认费用并申诉" }),
		).toBeDisabled();
	});
	it.each([
		["案件准备请求失败", "操作未完成，请刷新案件后重试。"],
		["用户拒绝钱包签名", "你已取消钱包操作，交易尚未发送。"],
	])(
		"%s 且没有广播哈希时，可以重新发起同一证据锚定",
		async (failure, safeMessage) => {
			const hash = `0x${"44".repeat(32)}` as const;
			vi.mocked(executeDaoCaseAction)
				.mockRejectedValueOnce(new Error(failure))
				.mockResolvedValueOnce(hash);
			const onRefresh = vi.fn();
			renderEvidence(onRefresh);
			const anchor = screen.getByRole("button", { name: "锚定你的证据 1" });
			fireEvent.click(anchor);
			expect(await screen.findByText(safeMessage)).toBeInTheDocument();
			expect(anchor).toBeEnabled();
			expect(
				screen.queryByRole("button", { name: "核验交易状态" }),
			).not.toBeInTheDocument();
			fireEvent.click(anchor);
			await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
			expect(executeDaoCaseAction).toHaveBeenCalledTimes(2);
		},
	);
	it("已有广播哈希的确认失败保留原证明同步入口，不重新发送证据交易", async () => {
		const hash = `0x${"44".repeat(32)}` as const;
		vi.mocked(executeDaoCaseAction).mockImplementationOnce(async (input) => {
			input.onBroadcast(hash);
			input.onProgress("confirming");
			throw new Error("等待链上确认超时");
		});
		vi.mocked(inspectDaoEvidence).mockResolvedValue(anchored());
		const onRefresh = vi.fn();
		renderEvidence(onRefresh);
		const anchor = screen.getByRole("button", { name: "锚定你的证据 1" });
		fireEvent.click(anchor);
		const retry = await screen.findByRole("button", {
			name: "核验交易状态",
		});
		expect(anchor).toBeDisabled();
		expect(screen.getByText(`交易：${hash}`)).toBeInTheDocument();
		fireEvent.click(retry);
		await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
		expect(inspectDaoEvidence).toHaveBeenCalledWith(
			"10000000-0000-4000-8000-000000000001",
			"10000000-0000-4000-8000-000000000002",
			hash,
		);
		expect(executeDaoCaseAction).toHaveBeenCalledTimes(1);
	});
	it("原交易仍未确认时不开放重新签名", async () => {
		broadcastThenFail();
		vi.mocked(inspectDaoEvidence).mockResolvedValue({
			evidenceId: "10000000-0000-4000-8000-000000000002",
			txHash: `0x${"44".repeat(32)}`,
			status: "pending",
			retryAllowed: false,
		});
		renderEvidence(vi.fn());
		fireEvent.click(screen.getByRole("button", { name: "锚定你的证据 1" }));
		fireEvent.click(
			await screen.findByRole("button", { name: "核验交易状态" }),
		);
		expect(await screen.findByText(/原交易仍未确认/)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "重新签名锚定证据" }),
		).not.toBeInTheDocument();
		expect(executeDaoCaseAction).toHaveBeenCalledTimes(1);
	});
	it("同一证据的全部已知哈希都确认回滚后才开放一次重新签名", async () => {
		const evidenceId = "10000000-0000-4000-8000-000000000002";
		const hashes = [`0x${"44".repeat(32)}`, `0x${"55".repeat(32)}`] as const;
		const store = createDaoEvidenceRecovery({
			walletAddress: actor,
			chainId: "31337",
			contractAddress: `0x${"22".repeat(20)}`,
			disputeId: "10000000-0000-4000-8000-000000000001",
		});
		for (const txHash of hashes) store.remember({ evidenceId, txHash });
		vi.mocked(inspectDaoEvidence).mockImplementation(
			async (_dispute, id, txHash) => ({
				evidenceId: id,
				txHash: txHash as `0x${string}`,
				status: "reverted",
				retryAllowed: true,
			}),
		);
		vi.mocked(executeDaoCaseAction).mockResolvedValue(`0x${"66".repeat(32)}`);
		renderEvidence(vi.fn());
		const checks = await screen.findAllByRole("button", {
			name: "核验交易状态",
		});
		expect(checks).toHaveLength(2);
		fireEvent.click(checks[0]);
		await screen.findByText(/该交易已确认回滚/);
		expect(
			screen.queryByRole("button", { name: "重新签名锚定证据" }),
		).not.toBeInTheDocument();
		fireEvent.click(checks[1]);
		const resign = await screen.findByRole("button", {
			name: "重新签名锚定证据",
		});
		fireEvent.click(resign);
		await waitFor(() => expect(executeDaoCaseAction).toHaveBeenCalledTimes(1));
		expect(executeDaoCaseAction).toHaveBeenCalledWith(
			expect.objectContaining({
				action: { action: "evidence", evidenceId },
			}),
		);
	});
	it("首审结论明确处于申诉期，拆分显示保证金和服务费，不显示已结算", () => {
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={info()}
				evidence={[]}
				onRefresh={vi.fn()}
			/>,
		);
		expect(screen.getByRole("heading", { name: "申诉期" })).toBeInTheDocument();
		expect(screen.getByText("2 USDC")).toBeInTheDocument();
		expect(screen.getByText("1 USDC")).toBeInTheDocument();
		expect(
			screen.getByText("从当前钱包另行支付，不从任务托管预算中扣除。"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "确认费用并申诉" }),
		).toBeEnabled();
		expect(screen.queryByText("已结算")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /领取/ }),
		).not.toBeInTheDocument();
	});
	it("没有当事人身份不展示收费申诉；VRF 等待时不提供重新抽签按钮", () => {
		const value = info();
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={{ ...value, viewerIsParty: false, status: "awaiting_randomness" }}
				evidence={[]}
				onRefresh={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "等待随机分案" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "确认费用并申诉" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /重新抽签/ }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "最终裁决" }),
		).toBeInTheDocument();
		expect(screen.getByText("尚未形成裁决")).toBeInTheDocument();
		expect(
			screen.getByText(
				"下一步：随机分案 → 仲裁员投票 → 首审结果 → 申诉或最终裁决",
			),
		).toBeInTheDocument();
	});
	it("恢复期公开硬截止和兜底比例，不再提示资金无限冻结", () => {
		const value = info();
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={{
					...value,
					status: "recovery",
					snapshot: value.snapshot && {
						...value.snapshot,
						status: "recovery",
						timeoutFallbackBasisPoints: 0,
					},
				}}
				evidence={[]}
				onRefresh={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "异常恢复期" }),
		).toBeInTheDocument();
		expect(screen.getByText(/恢复截止时间/)).toBeInTheDocument();
		expect(screen.getByText(/Agent 获得 0%/)).toBeInTheDocument();
		expect(
			screen.queryByText(/资金继续冻结，等待后续处理/),
		).not.toBeInTheDocument();
	});
	it("旧版 stalled 案件明确告知无需钱包操作并保留历史事实", () => {
		const value = info();
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={{
					...value,
					status: "stalled",
					snapshot: value.snapshot && {
						...value.snapshot,
						status: "stalled",
						round: 2,
					},
				}}
				evidence={[]}
				compensation={{
					status: "awaiting_funding",
					amountMinor: "12000000",
					currency: "USDC",
					paymentTxHash: null,
				}}
				onRefresh={vi.fn()}
			/>,
		);
		expect(
			screen.getByRole("heading", { name: "旧版案件已停止处理" }),
		).toBeInTheDocument();
		expect(screen.getByText("历史异常记录")).toBeInTheDocument();
		expect(screen.getByText(/该案件作为历史异常记录保留/)).toBeInTheDocument();
		expect(screen.getByText(/无需继续投票或操作钱包/)).toBeInTheDocument();
		expect(screen.getByText(/已单独登记 12 USDC/)).toBeInTheDocument();
		expect(screen.getByText(/未执行付款/)).toBeInTheDocument();
		expect(screen.getByText(/不会修改旧托管/)).toBeInTheDocument();
	});
	it("终审投票阶段说明参与不足会进入恢复，不再回退到首审文案", () => {
		const value = info();
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={{
					...value,
					status: "voting",
					snapshot: value.snapshot && {
						...value.snapshot,
						status: "voting",
						round: 2,
						panel: [actor, `0x${"22".repeat(20)}`, `0x${"33".repeat(20)}`],
						voteCount: 2,
					},
				}}
				evidence={[]}
				onRefresh={vi.fn()}
			/>,
		);
		expect(
			screen.getByText(
				"下一步：完成终审投票或等待截止 → 至少三票形成最终裁决，否则进入异常恢复",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/首审结果/)).not.toBeInTheDocument();
	});
	it("最终裁决且资金已解冻时显示结算已经链上确认", () => {
		const value = info();
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={{
					...value,
					status: "final",
					snapshot: value.snapshot && {
						...value.snapshot,
						status: "final",
						round: 2,
						releaseBasisPoints: 0,
					},
				}}
				evidence={[]}
				settlementConfirmed
				onRefresh={vi.fn()}
			/>,
		);
		expect(
			screen.getByText("裁决和资金结算均已链上确认。"),
		).toBeInTheDocument();
		const agentResult = screen.getByText(
			(_, element) =>
				element?.tagName === "P" &&
				element.textContent === "Agent 将获得任务款的 0%。",
		);
		const publisherResult = screen.getByText(
			(_, element) =>
				element?.tagName === "P" &&
				element.textContent === "发布者将收到剩余的 100% 任务款。",
		);
		expect(agentResult.parentElement).toBe(publisherResult.parentElement);
		expect(agentResult.parentElement).toHaveClass("text-sm", "leading-6");
		expect(agentResult.parentElement).not.toHaveClass("text-xs");
		expect(screen.queryByText(/结算仍需/)).not.toBeInTheDocument();
	});
	it("最终裁决后明确说明并领取申诉保证金", async () => {
		walletMock.credit.mockResolvedValue(BigInt(1_000_000));
		const value = info();
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={{ ...value, status: "final" }}
				evidence={[]}
				settlementConfirmed
				onRefresh={vi.fn()}
			/>,
		);
		expect(
			await screen.findByText(
				"1 USDC 申诉保证金正等待领取。0.1 USDC 服务费不退。",
			),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "领取申诉保证金 1 USDC" }),
		).toBeInTheDocument();
	});
	it("领取回执确认后立即结束确认状态并收起保证金入口", async () => {
		walletMock.credit.mockResolvedValue(BigInt(1_000_000));
		let release: (() => void) | undefined;
		const receipt = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(executeDaoCaseAction).mockImplementationOnce(async (input) => {
			input.onProgress("confirming");
			await receipt;
			return `0x${"55".repeat(32)}`;
		});
		const onRefresh = vi.fn();
		render(
			<DaoChainCasePanel
				disputeId="10000000-0000-4000-8000-000000000001"
				info={{ ...info(), status: "final" }}
				evidence={[]}
				settlementConfirmed
				onRefresh={onRefresh}
			/>,
		);
		fireEvent.click(
			await screen.findByRole("button", { name: "领取申诉保证金 1 USDC" }),
		);
		expect(await screen.findByText("等待链上确认")).toBeInTheDocument();
		await act(async () => release?.());
		await waitFor(() =>
			expect(screen.queryByText("等待链上确认")).not.toBeInTheDocument(),
		);
		expect(
			screen.getByText("交易已确认，正在更新案件状态…"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /领取申诉保证金/ }),
		).not.toBeInTheDocument();
		expect(onRefresh).toHaveBeenCalledOnce();
	});
});

function broadcastThenFail(hash: `0x${string}` = `0x${"44".repeat(32)}`) {
	vi.mocked(executeDaoCaseAction).mockImplementationOnce(async (input) => {
		input.onBroadcast(hash);
		throw new Error("等待链上确认超时");
	});
}

function anchored() {
	return {
		evidenceId: "10000000-0000-4000-8000-000000000002",
		txHash: `0x${"44".repeat(32)}` as const,
		status: "anchored" as const,
		retryAllowed: false as const,
	};
}

function renderEvidence(
	onRefresh: () => void,
	overrides: Partial<ComponentProps<typeof DaoChainCasePanel>> = {},
) {
	return render(
		<DaoChainCasePanel
			disputeId="10000000-0000-4000-8000-000000000001"
			info={{ ...info(), status: "evidence" }}
			evidence={[
				{
					id: "10000000-0000-4000-8000-000000000002",
					submittedBy: actor,
					integrity: "consistent",
				},
			]}
			onRefresh={onRefresh}
			{...overrides}
		/>,
	);
}

/** 金额仅为组件断言样本，不用于部署配置或真实用户收费。 */
function info(): ChainArbitration {
	return {
		chainId: "31337",
		contractAddress: `0x${"22".repeat(20)}`,
		caseKey: `0x${"33".repeat(32)}`,
		status: "appeal_window",
		lastErrorCode: null,
		viewerIsParty: true,
		snapshot: {
			status: "appeal_window",
			round: 1,
			evidenceRoot: `0x${"33".repeat(32)}`,
			evidenceDeadline: "1800000000",
			deadline: "1800000000",
			releaseBasisPoints: 5000,
			appealBondMinor: "2000000",
			appealFeeMinor: "1000000",
			rewardPerVoteMinor: "10000000000000000000",
			bondPolicy: 2,
			panel: [],
			firstPanel: [],
			voters: [],
			voteCount: 0,
			requestId: "42",
			blockNumber: "100",
			blockTimestamp: "1700000000",
		},
	};
}
