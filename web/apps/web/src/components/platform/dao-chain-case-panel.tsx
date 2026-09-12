"use client";

import { Button } from "@web/ui/components/button";
import { Input } from "@web/ui/components/input";
import { Textarea } from "@web/ui/components/textarea";
import {
	CheckCircle2,
	Clock3,
	Fingerprint,
	Loader2,
	Scale,
	ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { formatUnits, getAddress, parseAbi } from "viem";
import { readContract } from "wagmi/actions";
import { useWalletSession } from "@/components/auth/wallet-session-provider";
import { useLocale } from "@/components/i18n/locale-provider";
import {
	type ChainArbitration,
	type DaoCaseAction,
	type DaoEvidenceInspection,
	inspectDaoEvidence,
} from "@/lib/api/dao-cases";
import {
	type DaoCaseWalletStage,
	daoCaseWalletErrorMessage,
	executeDaoCaseAction,
} from "@/lib/wallet/dao-case-flow";
import {
	createDaoEvidenceRecovery,
	type DaoEvidenceRecoverySnapshot,
} from "@/lib/wallet/dao-evidence-recovery";
import {
	requireSupportedChainId,
	wagmiConfig,
} from "@/lib/wallet/wagmi-config";

/**
 * 链上案件侧栏只展示已确认阶段；投票/申诉的签名等待独立展示，不把乐观 UI 状态伪装成
 * 已裁决。申诉窗口明确拆开保证金和服务费，避免用户以为从原任务预算中扣第二次钱。
 */
export default function DaoChainCasePanel({
	disputeId,
	info,
	evidence,
	settlementConfirmed = false,
	compensation = null,
	onRefresh,
}: {
	disputeId: string;
	info: ChainArbitration;
	evidence: readonly {
		id: string;
		submittedBy: string;
		anchorTxHash?: string | null;
		integrity?: string;
	}[];
	settlementConfirmed?: boolean;
	compensation?: Readonly<{
		status: "awaiting_funding" | "submitted" | "confirmed" | "failed";
		amountMinor: string;
		currency: "USDC";
		paymentTxHash: string | null;
	}> | null;
	onRefresh(): void;
}) {
	const { locale } = useLocale();
	const en = locale === "en";
	const wallet = useWalletSession();
	const [progress, setProgress] = useState<DaoCaseWalletStage | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [messageIsError, setMessageIsError] = useState(false);
	const [pendingHash, setPendingHash] = useState<string | null>(null);
	const [evidenceInspections, setEvidenceInspections] = useState<
		Record<string, DaoEvidenceInspection>
	>({});
	const [credit, setCredit] = useState<bigint | null>(null);
	const [reason, setReason] = useState("");
	const [percentage, setPercentage] = useState("100");
	const snapshot = info.snapshot;
	const actor =
		wallet.status === "connected" ? wallet.walletAddress.toLowerCase() : "";
	const recoveryStore = useMemo(
		() =>
			createDaoEvidenceRecovery({
				walletAddress: actor,
				chainId: info.chainId,
				contractAddress: info.contractAddress,
				disputeId,
			}),
		[actor, info.chainId, info.contractAddress, disputeId],
	);
	const [recovery, setRecovery] = useState<{
		store: typeof recoveryStore;
		snapshot: DaoEvidenceRecoverySnapshot;
	} | null>(null);
	useEffect(() => {
		setRecovery({ store: recoveryStore, snapshot: recoveryStore.read() });
		setPendingHash(null);
		setMessage(null);
		setMessageIsError(false);
		setEvidenceInspections({});
	}, [recoveryStore]);
	// 身份切换后的首帧也不能展示旧钱包记录，不能等 effect 更新状态后才做隔离。
	const recoverySnapshot =
		recovery?.store === recoveryStore ? recovery.snapshot : null;
	const pendingEvidence = (recoverySnapshot?.records ?? []).filter((record) =>
		evidence.some(
			(entry) =>
				entry.id === record.evidenceId &&
				entry.submittedBy.toLowerCase() === actor &&
				!entry.anchorTxHash &&
				entry.integrity === "consistent",
		),
	);
	function updateRecovery(snapshot: DaoEvidenceRecoverySnapshot) {
		// 原钱包操作迟到的回调仍保存到原作用域，但不允许覆盖当前钱包的界面。
		setRecovery((current) =>
			current?.store === recoveryStore
				? { store: recoveryStore, snapshot }
				: current,
		);
	}
	function mayResignEvidence(evidenceId: string) {
		const attempts = pendingEvidence.filter(
			(record) => record.evidenceId === evidenceId,
		);
		return (
			attempts.length > 0 &&
			attempts.every((record) => {
				const inspected =
					evidenceInspections[`${record.evidenceId}:${record.txHash}`];
				return inspected?.status === "reverted" && inspected.retryAllowed;
			})
		);
	}
	const voted = snapshot?.voters.includes(actor) ?? false;
	const canVote =
		info.status === "voting" && snapshot?.panel.includes(actor) && !voted;
	const canAppeal = info.status === "appeal_window" && info.viewerIsParty;
	const [zhStatus, enStatus] = caseStatusLabels[info.status];
	const decisionAvailable =
		snapshot !== null && ["appeal_window", "final"].includes(info.status);
	const busy = progress !== null;
	const bps = Math.round(Number(percentage) * 100);
	const validPercentage = /^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/.test(
		percentage,
	);
	useEffect(() => {
		if (actor === "" || !["final", "stalled", "recovery"].includes(info.status))
			return;
		let cancelled = false;
		// 只在确实有可领取余额时显示提款按钮，不能让没有申诉或已经领过的用户反复失败。
		readContract(wagmiConfig, {
			chainId: requireSupportedChainId(Number(BigInt(info.chainId))),
			address: getAddress(info.contractAddress),
			abi: parseAbi(["function usdcCredit(address) view returns (uint256)"]),
			functionName: "usdcCredit",
			args: [getAddress(actor)],
		})
			.then((value) => {
				if (!cancelled) setCredit(value);
			})
			.catch(() => {
				if (!cancelled) setCredit(null);
			});
		return () => {
			cancelled = true;
		};
	}, [actor, info.chainId, info.contractAddress, info.status]);

	async function execute(action: DaoCaseAction) {
		if (wallet.status !== "connected" || busy) return;
		setMessage(null);
		setMessageIsError(false);
		setPendingHash(null);
		try {
			await executeDaoCaseAction({
				disputeId,
				walletAddress: wallet.walletAddress,
				caseInfo: info,
				action,
				onProgress: setProgress,
				onBroadcast: (hash) => {
					if (action.action === "evidence") {
						updateRecovery(
							recoveryStore.remember({
								evidenceId: action.evidenceId,
								txHash: hash,
							}),
						);
					} else setPendingHash(hash);
				},
			});
			setMessage(
				en
					? "Transaction confirmed. Updating the case…"
					: "交易已确认，正在更新案件状态…",
			);
			setMessageIsError(false);
			if (action.action === "evidence")
				updateRecovery(recoveryStore.forget(action.evidenceId));
			if (action.action === "claimUsdc") setCredit(BigInt(0));
			onRefresh();
		} catch (error) {
			// 广播时才保存恢复记录，准备失败可重试，广播后的错误则保留每条证据的原哈希。
			setMessage(daoCaseWalletErrorMessage(error, en));
			setMessageIsError(true);
		} finally {
			setProgress(null);
		}
	}

	return (
		<section className="rounded-2xl border border-primary/20 bg-card p-5 shadow-lg shadow-primary/5">
			<div className="flex items-center gap-3">
				<div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
					<Scale className="size-5" />
				</div>
				<div>
					<p className="text-muted-foreground text-xs">
						{en ? "DAO ARBITRATION" : "DAO 仲裁"}
					</p>
					<h2 className="font-semibold text-lg">{en ? enStatus : zhStatus}</h2>
				</div>
			</div>
			{snapshot && (
				<div className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-4 py-3 text-sm">
					<span>
						{snapshot.round === 2
							? en
								? "Appeal · 5 jurors"
								: "终审 · 5 人小组"
							: en
								? "First round · 3 jurors"
								: "首审 · 3 人小组"}
					</span>
					{info.status === "voting" && (
						<span className="font-medium text-primary tabular-nums">
							{snapshot.voteCount} / {snapshot.panel.length}{" "}
							{en ? "votes" : "票"}
						</span>
					)}
				</div>
			)}
			<p className="mt-4 text-muted-foreground text-sm leading-6">
				{info.status === "final" && settlementConfirmed
					? en
						? "The decision and fund settlement are both confirmed onchain."
						: "裁决和资金结算均已链上确认。"
					: en
						? caseStatusDescriptions[info.status][1]
						: caseStatusDescriptions[info.status][0]}
			</p>
			{compensation && (
				<div className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
					<p className="font-semibold text-foreground">
						{en ? "Legacy incident record" : "历史异常记录"}
					</p>
					<p className="mt-1 text-muted-foreground">
						{en
							? `${formatUnits(BigInt(compensation.amountMinor), 6)} USDC has been recorded separately. ${compensationStatus(compensation.status, true)}`
							: `已单独登记 ${formatUnits(BigInt(compensation.amountMinor), 6)} USDC。${compensationStatus(compensation.status, false)}`}
					</p>
					<p className="mt-2 text-muted-foreground text-xs">
						{en
							? "This does not change or disguise the locked legacy escrow."
							: "该记录不会修改旧托管，也不会被展示为原托管退款。"}
					</p>
				</div>
			)}
			{snapshot &&
				["evidence", "voting", "appeal_window", "recovery"].includes(
					info.status,
				) && (
					<p className="mt-3 flex items-center gap-2 text-muted-foreground text-xs">
						<Clock3 className="size-4 shrink-0" />
						{info.status === "recovery"
							? en
								? "Recovery deadline "
								: "恢复截止时间："
							: en
								? "Closes "
								: "截止时间："}
						{new Date(
							Number(
								BigInt(
									info.status === "evidence"
										? snapshot.evidenceDeadline
										: snapshot.deadline,
								),
							) * 1000,
						).toLocaleString(en ? "en-US" : "zh-CN")}
					</p>
				)}
			<div className="mt-5 rounded-xl border border-primary/15 bg-muted/20 p-4">
				<h3 className="font-medium text-sm">
					{info.status === "appeal_window"
						? en
							? "First-round outcome (appeal window)"
							: "首审结果（申诉期）"
						: en
							? "Final decision"
							: "最终裁决"}
				</h3>
				{decisionAvailable ? (
					<div className="mt-2 space-y-1 text-sm leading-6">
						<p>
							{en ? "The Agent receives " : "Agent 将获得任务款的 "}
							<span className="font-semibold text-primary">
								{snapshot.releaseBasisPoints / 100}%
							</span>
							{en ? "." : "。"}
						</p>
						<p>
							{en
								? "The publisher receives the remaining "
								: "发布者将收到剩余的 "}
							<span className="font-semibold text-primary">
								{(10_000 - snapshot.releaseBasisPoints) / 100}%
							</span>
							{en ? " of the task payment." : " 任务款。"}
						</p>
					</div>
				) : (
					<>
						<p className="mt-2 font-semibold text-foreground text-sm">
							{info.status === "stalled"
								? en
									? "No valid majority"
									: "未形成有效多数"
								: info.status === "recovery"
									? en
										? "Recovery review in progress"
										: "正在进行恢复审议"
									: en
										? "No decision yet"
										: "尚未形成裁决"}
						</p>
						<p className="mt-1 text-muted-foreground text-xs leading-5">
							{remainingDecisionSteps(
								info.status,
								en,
								snapshot?.round,
								snapshot?.timeoutFallbackBasisPoints,
							)}
						</p>
					</>
				)}
			</div>
			{info.lastErrorCode && (
				<p
					role="status"
					className="mt-4 rounded-xl border border-warning/20 bg-warning/5 p-3 text-sm leading-6"
				>
					{caseProgressErrorMessage(info.lastErrorCode, en)}
				</p>
			)}
			{canVote && (
				<div className="mt-5 space-y-4 border-t pt-5">
					<label
						className="block font-medium text-sm"
						htmlFor="dao-release-percentage"
					>
						{en ? "Pay Agents (%)" : "结算给 Agent 的比例（%）"}
					</label>
					<Input
						id="dao-release-percentage"
						inputMode="decimal"
						value={percentage}
						onChange={(event) => setPercentage(event.target.value)}
					/>
					<p className="text-muted-foreground text-xs">
						{en
							? "0 = full refund · 100 = full payment"
							: "0 为全额退款，100 为全额结算"}
					</p>
					<label
						className="block font-medium text-sm"
						htmlFor="dao-vote-reason"
					>
						{en ? "Reasoning" : "裁决理由"}
					</label>
					<Textarea
						id="dao-vote-reason"
						className="min-h-32"
						maxLength={5000}
						value={reason}
						onChange={(event) => setReason(event.target.value)}
						placeholder={
							en
								? "Reference the requirements and evidence (at least 10 characters)."
								: "请引用具体需求与证据说明理由，至少 10 个字符。"
						}
					/>
					<Button
						size="lg"
						className="w-full cursor-pointer"
						disabled={busy || !validPercentage || reason.trim().length < 10}
						onClick={() =>
							execute({
								action: "vote",
								releaseBasisPoints: bps,
								reasoning: reason,
							})
						}
					>
						{busy ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<ShieldCheck className="size-4" />
						)}
						{en ? "Sign and vote" : "签名并投票"}
					</Button>
				</div>
			)}
			{voted && (
				<p className="mt-5 flex items-center gap-2 text-primary text-sm">
					<CheckCircle2 className="size-4" />
					{en ? "Your vote is recorded on-chain." : "你的投票已记录在链上。"}
				</p>
			)}
			{canAppeal && snapshot && (
				<div className="mt-5 space-y-3 border-t pt-5">
					<h3 className="font-medium text-sm">
						{en ? "Request one appeal" : "申请一次申诉"}
					</h3>
					<dl className="space-y-2 text-sm">
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">
								{en ? "Bond" : "保证金"}
							</dt>
							<dd>{formatUnits(BigInt(snapshot.appealBondMinor), 6)} USDC</dd>
						</div>
						<div className="flex justify-between gap-4">
							<dt className="text-muted-foreground">
								{en ? "Service fee" : "服务费"}
							</dt>
							<dd>{formatUnits(BigInt(snapshot.appealFeeMinor), 6)} USDC</dd>
						</div>
					</dl>
					<p className="text-muted-foreground text-xs leading-5">
						{snapshot.bondPolicy === 0
							? en
								? "The bond return policy is not configured. Appeals are unavailable."
								: "保证金退还政策尚未配置，暂不能申诉。"
							: snapshot.bondPolicy === 1
								? en
									? "The bond is returned after the appeal; the service fee is non-refundable."
									: "申诉结束后退回保证金，服务费不退。"
								: en
									? "The bond is returned if the decision changes; otherwise it goes to the independent arbitration treasury. The service fee is non-refundable."
									: "改判退回保证金；维持原裁决则转入独立仲裁池。服务费不退。"}
					</p>
					<p className="text-muted-foreground text-xs leading-5">
						{en
							? "Paid separately from your wallet, not from the task budget."
							: "从当前钱包另行支付，不从任务托管预算中扣除。"}
					</p>
					<Button
						size="lg"
						variant="outline"
						className="w-full cursor-pointer"
						disabled={busy || snapshot.bondPolicy === 0}
						onClick={() => execute({ action: "appeal" })}
					>
						{en ? "Confirm fees and appeal" : "确认费用并申诉"}
					</Button>
				</div>
			)}
			{credit !== null && credit > BigInt(0) && (
				<div className="mt-5 rounded-xl border border-secondary/25 bg-secondary/5 p-4">
					<p className="font-medium text-sm">
						{en ? "Appeal bond ready to claim" : "申诉保证金可领取"}
					</p>
					<p className="mt-1 text-muted-foreground text-xs leading-5">
						{en
							? `${formatUnits(credit, 6)} USDC from your appeal bond is waiting for withdrawal. The 0.1 USDC service fee is non-refundable.`
							: `${formatUnits(credit, 6)} USDC 申诉保证金正等待领取。0.1 USDC 服务费不退。`}
					</p>
					<Button
						size="lg"
						variant="outline"
						className="mt-3 w-full cursor-pointer"
						disabled={busy}
						onClick={() => execute({ action: "claimUsdc" })}
					>
						{en ? "Claim appeal bond " : "领取申诉保证金 "}
						{formatUnits(credit, 6)} USDC
					</Button>
				</div>
			)}
			{info.status === "evidence" &&
				evidence
					.filter(
						(entry) =>
							entry.submittedBy.toLowerCase() === actor &&
							!entry.anchorTxHash &&
							entry.integrity === "consistent",
					)
					.map((entry, index) => (
						<Button
							key={entry.id}
							size="lg"
							variant="outline"
							className="mt-4 w-full cursor-pointer"
							disabled={
								busy ||
								pendingEvidence.some((record) => record.evidenceId === entry.id)
							}
							onClick={() =>
								execute({ action: "evidence", evidenceId: entry.id })
							}
						>
							<Fingerprint className="size-4" />
							{en
								? `Anchor your evidence ${index + 1}`
								: `锚定你的证据 ${index + 1}`}
						</Button>
					))}
			{recoverySnapshot?.issue && (
				<p role="status" className="mt-4 text-sm text-warning leading-6">
					{recoverySnapshot.issue === "invalid"
						? en
							? "Stored recovery data is invalid and was ignored. Keep your transaction hashes for manual verification."
							: "浏览器中的恢复记录无效，已忽略。请保留交易哈希以便人工核验。"
						: en
							? "Your browser could not save recovery data. Copy the transaction hashes before refreshing; manual verification may be needed."
							: "浏览器无法保存恢复记录。刷新前请复制交易哈希，必要时交由平台人工核验。"}
				</p>
			)}
			{pendingEvidence.map((record) => (
				<div
					key={`${record.evidenceId}:${record.txHash}`}
					className="mt-4 rounded-xl border p-3"
				>
					<p className="text-muted-foreground text-xs leading-5">
						{en
							? "Check the original transaction first. Re-signing is available only after every known hash is confirmed reverted; pending or orphaned receipts must keep waiting."
							: "请先核验原交易。只有全部已知哈希都确认回滚后才能重新签名；未确认或孤块回执必须继续等待。"}
					</p>
					<p className="text-muted-foreground text-xs leading-5">
						{en
							? "Evidence transaction awaiting verification: "
							: "证据交易待核验："}
						{record.evidenceId}
					</p>
					<p className="mt-3 break-all font-mono text-muted-foreground text-xs">
						{en ? "Transaction: " : "交易："}
						{record.txHash}
					</p>
					<Button
						size="lg"
						variant="ghost"
						className="mt-3 cursor-pointer"
						onClick={async () => {
							try {
								await navigator.clipboard.writeText(record.txHash);
								setMessage(
									en ? "Transaction hash copied." : "交易哈希已复制。",
								);
								setMessageIsError(false);
							} catch {
								setMessage(
									en
										? "Copy failed. Select and copy the full transaction hash above."
										: "复制失败，请选中上方完整交易哈希手动复制。",
								);
								setMessageIsError(true);
							}
						}}
					>
						{en ? "Copy transaction hash" : "复制交易哈希"}
					</Button>
					<Button
						size="lg"
						variant="outline"
						className="mt-4 w-full cursor-pointer"
						disabled={busy}
						onClick={async () => {
							setProgress("confirming");
							setMessage(null);
							setMessageIsError(false);
							try {
								const inspected = await inspectDaoEvidence(
									disputeId,
									record.evidenceId,
									record.txHash,
								);
								if (inspected.status === "anchored") {
									updateRecovery(recoveryStore.forget(record.evidenceId));
									onRefresh();
								} else {
									setEvidenceInspections((current) => ({
										...current,
										[`${record.evidenceId}:${record.txHash}`]: inspected,
									}));
									setMessage(evidenceInspectionMessage(inspected, en));
									setMessageIsError(true);
								}
							} catch (error) {
								setMessage(daoCaseWalletErrorMessage(error, en));
								setMessageIsError(true);
							} finally {
								setProgress(null);
							}
						}}
					>
						{en ? "Check transaction status" : "核验交易状态"}
					</Button>
					{mayResignEvidence(record.evidenceId) &&
						pendingEvidence.find(
							(entry) => entry.evidenceId === record.evidenceId,
						)?.txHash === record.txHash && (
							<Button
								size="lg"
								variant="outline"
								className="mt-3 w-full cursor-pointer"
								disabled={busy}
								onClick={() =>
									execute({ action: "evidence", evidenceId: record.evidenceId })
								}
							>
								<Fingerprint className="size-4" />
								{en ? "Re-sign evidence anchor" : "重新签名锚定证据"}
							</Button>
						)}
				</div>
			))}
			{busy && (
				<p
					role="status"
					className="mt-4 flex items-center gap-2 text-primary text-sm"
				>
					<Loader2 className="size-4 animate-spin" />
					{en ? progressLabels[progress][1] : progressLabels[progress][0]}
				</p>
			)}
			{message && (
				<p
					role={messageIsError ? "alert" : "status"}
					className={`mt-4 text-sm leading-6 ${messageIsError ? "text-destructive" : ""}`}
				>
					{message}
				</p>
			)}
			{pendingHash && (
				<p className="mt-3 break-all font-mono text-muted-foreground text-xs">
					{en ? "Transaction: " : "交易："}
					{pendingHash}
				</p>
			)}
			{snapshot && (
				<details className="group mt-5 border-t pt-4 text-muted-foreground text-xs">
					<summary className="flex cursor-pointer items-center gap-2 py-1">
						<Fingerprint className="size-4" />
						{en ? "Verification details" : "链上验证信息"}
						<span className="ml-auto transition-transform group-open:rotate-90">
							›
						</span>
					</summary>
					<dl className="mt-3 space-y-3 break-all">
						<div>
							<dt>{en ? "Case contract" : "案件合约"}</dt>
							<dd className="mt-1 font-mono">{info.contractAddress}</dd>
						</div>
						<div>
							<dt>{en ? "Evidence commitment" : "证据承诺"}</dt>
							<dd className="mt-1 font-mono">{snapshot.evidenceRoot}</dd>
						</div>
						<div>
							<dt>VRF Request ID</dt>
							<dd className="mt-1 font-mono">
								{snapshot.requestId === "0"
									? en
										? "Not requested"
										: "尚未请求"
									: snapshot.requestId}
							</dd>
						</div>
					</dl>
				</details>
			)}
		</section>
	);
}

function caseProgressErrorMessage(code: string, en: boolean): string {
	if (code === "DAO_PANEL_INSUFFICIENT") {
		return en
			? "Waiting for enough eligible jurors. Your task funds remain frozen."
			: "正在等待足够的合格成员，任务资金继续冻结。";
	}
	if (code === "DAO_CASE_OPERATOR_INSUFFICIENT_FUNDS") {
		return en
			? "The case operator needs Sepolia ETH for gas. Processing resumes after the platform funds it; your task funds remain frozen."
			: "案件操作账户缺少 Sepolia ETH 支付 Gas；平台补充后会继续处理，任务资金仍被冻结。";
	}
	if (code === "DAO_REWARD_POOL_INSUFFICIENT") {
		return en
			? "The arbitration reward pool needs more YD before processing can continue. Your task funds remain frozen."
			: "仲裁奖励池需要补充 YD 后才能继续处理，任务资金仍被冻结。";
	}
	return en
		? "Case progression needs attention. No early payout will be made."
		: "案件推进遇到问题，需要检查后恢复。不会提前释放任务资金。";
}

function compensationStatus(
	status: "awaiting_funding" | "submitted" | "confirmed" | "failed",
	en: boolean,
): string {
	const labels = {
		awaiting_funding: [
			"此前登记过补偿意向，但未执行付款；该记录仅作为历史审计事实保留。",
			"A compensation intent was recorded but never paid; it remains only as historical audit evidence.",
		],
		submitted: [
			"付款交易已提交，正在等待确认。",
			"The payment transaction is awaiting confirmation.",
		],
		confirmed: [
			"补偿付款已经链上确认。",
			"The compensation payment is confirmed onchain.",
		],
		failed: [
			"付款交易失败，平台需要重新处理。",
			"The payment failed and requires platform recovery.",
		],
	} as const;
	return labels[status][en ? 1 : 0];
}

function evidenceInspectionMessage(
	result: DaoEvidenceInspection,
	en: boolean,
): string {
	if (result.status === "pending")
		return en
			? "The original transaction is still pending or not yet canonical. Keep this hash and check again later."
			: "原交易仍未确认或尚未进入规范链，请保留哈希后稍后再次核验。";
	if (result.status === "invalid")
		return en
			? "This transaction does not match the current evidence, wallet, or contract. Keep the hash for manual review."
			: "该交易与当前证据、钱包或合约不匹配，请保留哈希并交由人工核验。";
	if (result.status === "reverted" && result.retryAllowed)
		return en
			? "This transaction is confirmed reverted. Re-signing unlocks after every known hash is also confirmed reverted."
			: "该交易已确认回滚；同一证据的全部已知哈希都确认回滚后可重新签名。";
	return en
		? "This transaction reverted, but the evidence window has closed. Re-signing is unavailable."
		: "该交易已回滚，但举证窗口已经关闭，不能重新签名。";
}

/** 状态解释集中维护；暂停/等待不是完成，也不以虚构的百分比掩盖外部异步等待。 */
export const caseStatusLabels = {
	pending_registration: ["案件登记中", "Registering case"],
	evidence: ["双方举证", "Evidence collection"],
	awaiting_panel: ["等待仲裁小组", "Awaiting jurors"],
	awaiting_randomness: ["等待随机分案", "Awaiting VRF"],
	randomness_ready: ["正在组建小组", "Selecting jurors"],
	voting: ["小组审议中", "Jurors are voting"],
	appeal_window: ["申诉期", "Appeal window"],
	final: ["裁决已确定", "Final decision"],
	stalled: ["旧版案件已停止处理", "Legacy case closed without recovery"],
	recovery: ["异常恢复期", "Recovery period"],
} as const;
const caseStatusDescriptions = {
	pending_registration: [
		"争议已受理，任务资金已冻结，正在确认链上案件登记。",
		"The dispute is open and task funds are frozen while registration is confirmed.",
	],
	evidence: [
		"双方可补充证据。证据截止后才开始随机分案。",
		"Both parties may submit evidence. Random selection starts after the deadline.",
	],
	awaiting_panel: [
		"从已质押的合格成员中排除利益相关方，准备仲裁小组。",
		"Eligible staked members are screened for conflicts before selection.",
	],
	awaiting_randomness: [
		"等待 Chainlink VRF 返回可验证随机数，候选名单已经冻结。",
		"Waiting for verifiable randomness from Chainlink VRF. The candidate set is fixed.",
	],
	randomness_ready: [
		"随机数已返回，将按固定规则选出本轮成员。",
		"Randomness received. This round’s jurors are being selected deterministically.",
	],
	voting: [
		"成员独立审阅双方证据并投票，资金继续冻结。",
		"Jurors review evidence and vote independently. Task funds remain frozen.",
	],
	appeal_window: [
		"首审已有结论，申诉期内不会付款。当事人可申请一次五人终审。",
		"A provisional outcome is available. Funds remain frozen while either party may request a five-juror appeal.",
	],
	final: [
		"裁决已确定，资金结算仍需独立的链上执行确认。",
		"The outcome is final. Payment still requires a separately confirmed settlement transaction.",
	],
	stalled: [
		"旧版合约未提供异常恢复入口，原托管资金无法继续结算；该案件作为历史异常记录保留，当事人无需继续操作。",
		"The legacy contract has no recovery action, so the original escrow cannot settle. The case remains as a historical incident and requires no further party action.",
	],
	recovery: [
		"终审参与不足，受权恢复方可在硬截止前审议；到期后任何人都能执行公开兜底。",
		"Final-round participation was insufficient. An authorized resolver may decide before the hard deadline; afterward anyone can execute the published fallback.",
	],
} as const;

function remainingDecisionSteps(
	status: ChainArbitration["status"],
	en: boolean,
	round?: number,
	timeoutFallbackBasisPoints?: number | null,
): string {
	if (
		round === 2 &&
		(status === "awaiting_randomness" || status === "randomness_ready")
	)
		return en
			? "Next: final-round assignment → juror voting → final decision, or recovery if fewer than three jurors participate"
			: "下一步：终审随机分案 → 仲裁员投票 → 最终裁决；少于三人参与则进入异常恢复";
	if (status === "awaiting_randomness" || status === "randomness_ready")
		return en
			? "Next: random assignment → juror voting → first-round outcome → appeal or final decision"
			: "下一步：随机分案 → 仲裁员投票 → 首审结果 → 申诉或最终裁决";
	if (status === "voting" && round === 2)
		return en
			? "Next: complete final-round voting or wait for the deadline → final decision with at least three votes, otherwise recovery"
			: "下一步：完成终审投票或等待截止 → 至少三票形成最终裁决，否则进入异常恢复";
	if (status === "voting")
		return en
			? "Next: complete juror voting → first-round outcome → appeal or final decision"
			: "下一步：完成仲裁员投票 → 首审结果 → 申诉或最终裁决";
	if (status === "stalled")
		return en
			? "No further vote or wallet action is available. The original escrow remains locked as a legacy incident."
			: "无需继续投票或操作钱包；原托管资金仍锁定，并作为旧版异常事实保留。";
	if (status === "recovery") {
		const percentage =
			timeoutFallbackBasisPoints === null ||
			timeoutFallbackBasisPoints === undefined
				? null
				: timeoutFallbackBasisPoints / 100;
		return en
			? `An authorized resolver may decide before the deadline. Afterward, the published fallback${percentage === null ? "" : ` of ${percentage}% to Agents`} becomes executable by anyone.`
			: `受权恢复方可在截止前裁决；到期后任何人都能执行公开兜底${percentage === null ? "" : `（Agent 获得 ${percentage}%）`}。`;
	}
	return en
		? "Next: complete evidence → random assignment → juror voting → first-round outcome → appeal or final decision"
		: "下一步：完成举证 → 随机分案 → 仲裁员投票 → 首审结果 → 申诉或最终裁决";
}
const progressLabels = {
	preparing: ["正在核对案件", "Checking case"],
	authorizing: ["请确认 USDC 授权", "Approve USDC"],
	submitting: ["请确认案件交易", "Confirm the transaction"],
	confirming: ["等待链上确认", "Waiting for confirmation"],
} as const;
