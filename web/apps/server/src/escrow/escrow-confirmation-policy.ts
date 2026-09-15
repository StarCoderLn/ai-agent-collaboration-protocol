export type EscrowConfirmationPolicyInput = Readonly<{
	chainId: bigint;
	environment: string;
	configuredConfirmations?: string;
}>;

/**
 * 集中决定链上事件的确认阈值，避免本地启动器、HTTP 依赖和未来 worker 各自猜一套默认值。
 *
 * 生产环境没有安全的通用默认值：主网、L2 和测试网的出块/重组语义不同，资金风险也不同，
 * 因此必须由部署配置显式给出。非生产环境则以“快速验证状态边界”为目标：本地/测试链用
 * 2 次确认；开发环境若直接连接 Ethereum 主网则用更谨慎的 6 次确认。
 */
export function resolveEscrowRequiredConfirmations(
	input: EscrowConfirmationPolicyInput,
): bigint {
	const configured = input.configuredConfirmations?.trim();
	if (configured !== undefined && configured !== "") {
		return positiveBigint("ESCROW_REQUIRED_CONFIRMATIONS", configured);
	}
	if (input.environment === "production") {
		throw new Error("生产环境必须显式配置 ESCROW_REQUIRED_CONFIRMATIONS");
	}
	return input.chainId === 1n ? 6n : 2n;
}

function positiveBigint(name: string, value: string): bigint {
	if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
		throw new Error(`${name} 必须是正整数`);
	}
	return BigInt(value);
}
