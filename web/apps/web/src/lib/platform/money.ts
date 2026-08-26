/** 原生 ETH MVP 的展示与输入边界；业务 API 中的 amountMinor 在这里等同于 wei。 */
export const MVP_CURRENCY = "ETH" as const;
const WEI_DECIMALS = 18;
const WEI_PER_ETH = BigInt("1000000000000000000");

/**
 * 把用户输入的 ETH 十进制金额无损转换为 wei 字符串。
 * 禁止经过 Number，避免 18 位小数和大额整数发生精度丢失。
 */
export function parseEthToWei(value: string): string | null {
	const match = /^(\d+)(?:\.(\d{1,18}))?$/.exec(value.trim());
	if (match === null || match[1] === undefined) return null;
	const fraction = (match[2] ?? "").padEnd(WEI_DECIMALS, "0");
	const wei = BigInt(match[1]) * WEI_PER_ETH + BigInt(fraction || "0");
	return wei > BigInt(0) ? wei.toString() : null;
}

/** 使用 BigInt 格式化，保留有效小数且不把金额转换为不安全的 JavaScript number。 */
export function formatMinorAmount(amountMinor: string, currency: string): string {
	const amount = BigInt(amountMinor);
	if (currency === MVP_CURRENCY) {
		const whole = amount / WEI_PER_ETH;
		const rawFraction = (amount % WEI_PER_ETH).toString().padStart(WEI_DECIMALS, "0");
		const fraction = rawFraction.replace(/0+$/, "");
		const decimal = fraction === "" ? "" : `.${fraction}`;
		return `${new Intl.NumberFormat("zh-CN").format(whole)}${decimal} ${MVP_CURRENCY}`;
	}

	// 历史目录数据可能仍使用两位最小单位币种；只读展示不进行隐式换币。
	const whole = amount / BigInt(100);
	const fraction = (amount % BigInt(100)).toString().padStart(2, "0");
	return `${new Intl.NumberFormat("zh-CN").format(whole)}.${fraction} ${currency}`;
}
