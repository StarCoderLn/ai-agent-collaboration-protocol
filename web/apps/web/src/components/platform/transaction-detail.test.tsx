import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "@/components/i18n/locale-provider";
import {
	lookupTransaction,
	type OnchainTransactionDetail,
} from "@/lib/onchain/transaction-detail";
import TransactionDetail from "./transaction-detail";

vi.mock("@/lib/onchain/transaction-detail", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@/lib/onchain/transaction-detail")>();
	return { ...actual, lookupTransaction: vi.fn() };
});

const HASH = `0x${"12".repeat(32)}`;
const TASK_KEY = `0x${"34".repeat(32)}`;
const MANIFEST = `0x${"56".repeat(32)}`;
const EVIDENCE = `0x${"78".repeat(32)}`;
const ESCROW = "0x8a791620dd6260079bf849dc5567adc3f2fdc318";
const USDC = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
const PAYER = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const PAYEE = "0x6de38f0f6f2cf0d133db4ddbf143618bff9ea83a";

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("transaction detail", () => {
	it("把成功的统一结算回执转成用户可核对的金额、分账与链上字段", async () => {
		vi.mocked(lookupTransaction).mockResolvedValue({
			kind: "found",
			detail: settledTransaction(),
		});

		renderPage();

		expect(
			await screen.findByText("任务资金已完成统一结算"),
		).toBeInTheDocument();
		expect(screen.getAllByText("25 USDC").length).toBeGreaterThan(0);
		expect(screen.getAllByText("0.1 USDC").length).toBeGreaterThan(0);
		expect(screen.getAllByText("24.9 USDC").length).toBeGreaterThan(0);
		expect(
			screen.getByText("AICP Local Anvil · Chain ID 31337"),
		).toBeInTheDocument();
		expect(screen.getByText("3 次确认")).toBeInTheDocument();
		expect(screen.queryByText("在区块浏览器查看")).not.toBeInTheDocument();
	});

	it("测试网交易从站内记录页新标签打开对应的公共区块浏览器", async () => {
		vi.mocked(lookupTransaction).mockResolvedValue({
			kind: "found",
			detail: {
				...settledTransaction(),
				chainId: 11_155_111,
				chainName: "Sepolia",
			},
		});

		renderPage();

		await screen.findByText("Sepolia · Chain ID 11155111");
		const explorerLink = screen.getByText("在区块浏览器查看").closest("a");
		expect(explorerLink).not.toBeNull();
		expect(explorerLink).toHaveAttribute(
			"href",
			`https://sepolia.etherscan.io/tx/${HASH}`,
		);
		expect(explorerLink).toHaveAttribute("target", "_blank");
	});

	it("RPC 暂时失败时保留页面并允许原地重新读取，而不是误报交易不存在", async () => {
		vi.mocked(lookupTransaction)
			.mockRejectedValueOnce(new Error("RPC 暂时不可用"))
			.mockResolvedValueOnce({ kind: "found", detail: settledTransaction() });

		renderPage();
		expect(await screen.findByText("RPC 暂时不可用")).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "重新加载" }));

		expect(
			await screen.findByText("任务资金已完成统一结算"),
		).toBeInTheDocument();
		expect(lookupTransaction).toHaveBeenCalledTimes(2);
	});

	it("非法哈希显示明确错误，且不会伪造任何交易数据", async () => {
		vi.mocked(lookupTransaction).mockResolvedValue({ kind: "invalid_hash" });

		renderPage("not-a-hash");

		expect(await screen.findByText("交易哈希格式不正确")).toBeInTheDocument();
		expect(screen.queryByText("交易成功")).not.toBeInTheDocument();
	});
});

function renderPage(hash = HASH) {
	return render(
		<LocaleProvider initialLocale="zh-CN">
			<TransactionDetail
				hash={hash}
				returnHref="/tasks"
				returnLabel="返回任务市场"
			/>
		</LocaleProvider>,
	);
}

/**
 * 夹具复现真实结算的关键不变量：25 USDC 毛额、0.1 USDC 费用、24.9 USDC 净到账，
 * 并保留同一笔回执中的 WorkflowPayoutReleased、WorkflowSettled 与 Transfer 证据。
 */
function settledTransaction(): OnchainTransactionDetail {
	return {
		hash: HASH,
		chainId: 31_337,
		chainName: "AICP Local Anvil",
		status: "success",
		blockNumber: "30",
		blockHash: `0x${"ab".repeat(32)}`,
		confirmations: "3",
		timestamp: "2026-09-05T10:00:00.000Z",
		from: PAYER,
		to: ESCROW,
		valueWei: "0",
		nonce: 12,
		gasLimit: "120000",
		gasUsed: "94410",
		effectiveGasPriceWei: "1022002158",
		feeWei: "96487323877800",
		input: "0x1234",
		activities: [
			{
				kind: "token_transfer",
				logIndex: 0,
				contractAddress: USDC,
				asset: "USDC",
				decimals: 6,
				from: ESCROW,
				to: PAYEE,
				amountMinor: "24900000",
			},
			{
				kind: "workflow_payout",
				logIndex: 1,
				contractAddress: ESCROW,
				taskKey: TASK_KEY,
				payoutIndex: "0",
				payee: PAYEE,
				grossAmountMinor: "25000000",
				feeAmountMinor: "100000",
				netAmountMinor: "24900000",
			},
			{
				kind: "workflow_settlement",
				logIndex: 3,
				contractAddress: ESCROW,
				taskKey: TASK_KEY,
				settlementManifestHash: MANIFEST,
				evidenceRoot: EVIDENCE,
				payer: PAYEE,
				escrowAmountMinor: "25000000",
				totalGrossAmountMinor: "25000000",
				totalFeeAmountMinor: "100000",
				payerRefundAmountMinor: "0",
			},
		],
	};
}
