/** Web 与 Marketplace API 共用的唯一业务结算币种；ETH 只用于底层网络 Gas。 */
export const MVP_CURRENCY = "USDC" as const;
const USDC_DECIMALS = 6;
const USDC_MINOR_UNITS = BigInt("1000000");
// 表单即时校验必须与 Marketplace API 的资金契约一致。常量使用最小单位 bigint，
// 禁止通过 Number 比较金额，避免 6 位精度金额在边界处出现舍入差异。
export const MIN_USDC_BUSINESS_AMOUNT_MINOR = USDC_MINOR_UNITS;
export const MAX_TASK_BUDGET_MINOR = BigInt("100000000000"); // 100,000 USDC

/** 编辑接口接收最小单位字符串；该守卫让注册与编辑表单复用同一条最低报价规则。 */
export function isAtLeastMinimumUsdcAmountMinor(value: string): boolean {
	return /^\d+$/.test(value) && BigInt(value) >= MIN_USDC_BUSINESS_AMOUNT_MINOR;
}

/**
 * 把用户输入的 USDC 十进制金额无损转换为 6 位最小单位字符串。
 * 禁止经过 Number，避免较大预算或尾数在浏览器浮点运算中悄悄损失精度。
 */
export function parseUsdcToMinor(value: string): string | null {
	const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(value.trim());
	if (match === null || match[1] === undefined) return null;
	const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
	const amount = BigInt(match[1]) * USDC_MINOR_UNITS + BigInt(fraction || "0");
	return amount > BigInt(0) ? amount.toString() : null;
}

/** 把 API 的 USDC 最小单位还原为表单十进制值，不附加币种或千分位，便于再次编辑。 */
export function formatUsdcInputAmount(amountMinor: string): string {
	const amount = BigInt(amountMinor);
	const whole = amount / USDC_MINOR_UNITS;
	const rawFraction = (amount % USDC_MINOR_UNITS)
		.toString()
		.padStart(USDC_DECIMALS, "0");
	const fraction = rawFraction.replace(/0+$/, "");
	return `${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * 业务数据只允许 USDC，因此未知币种保持原始最小单位展示，不猜测其精度或汇率。
 * 这既避免错误换算，也能让异常历史数据在运营页面上保持可见。
 */
export function formatMinorAmount(
	amountMinor: string,
	currency: string,
): string {
	const amount = BigInt(amountMinor);
	if (currency !== MVP_CURRENCY) return `${amountMinor} ${currency}`;

	const whole = amount / USDC_MINOR_UNITS;
	const rawFraction = (amount % USDC_MINOR_UNITS)
		.toString()
		.padStart(USDC_DECIMALS, "0");
	const fraction = rawFraction.replace(/0+$/, "");
	const decimal = fraction === "" ? "" : `.${fraction}`;
	return `${new Intl.NumberFormat("zh-CN").format(whole)}${decimal} ${MVP_CURRENCY}`;
}
