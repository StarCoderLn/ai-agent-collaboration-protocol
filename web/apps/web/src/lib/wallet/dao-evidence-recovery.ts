import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const scopeSchema = z.object({
	walletAddress: address,
	chainId: z.string().regex(/^[1-9][0-9]*$/),
	contractAddress: address,
	disputeId: z.uuid(),
});
const recordSchema = z
	.object({
		evidenceId: z.uuid(),
		txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
	})
	.strict();
export type DaoEvidenceRecoveryRecord = z.infer<typeof recordSchema>;
export type DaoEvidenceRecoverySnapshot = {
	records: readonly DaoEvidenceRecoveryRecord[];
	issue: "unavailable" | "invalid" | null;
};

/**
 * 每个钱包/链/合约/案件拥有独立恢复日志，只保存证据 ID 与交易哈希。
 * 本地日志不是链上证明；调用方还须匹配服务端卷宗，并只让用户手动请求服务端验真。
 * 每个实例保留内存副本，存储拒绝或配额耗尽时不能让已经广播的哈希随错误一起丢失。
 * 每笔尝试使用证据 ID 与哈希组成的独立键，同一证据并发广播也不能覆盖早先可能成功的交易。
 */
export function createDaoEvidenceRecovery(scope: z.infer<typeof scopeSchema>) {
	const parsedScope = scopeSchema.safeParse(scope);
	const prefix = parsedScope.success
		? `aicp:dao-evidence:${scope.walletAddress.toLowerCase()}:${scope.chainId}:${scope.contractAddress.toLowerCase()}:${scope.disputeId}:`
		: null;
	let loaded = false;
	let records: DaoEvidenceRecoveryRecord[] = [];
	let issue: DaoEvidenceRecoverySnapshot["issue"] = null;
	const read = (): DaoEvidenceRecoverySnapshot => {
		if (!loaded) {
			loaded = true;
			try {
				if (prefix !== null) {
					const storage = window.localStorage;
					for (let index = 0; index < storage.length; index++) {
						const key = storage.key(index);
						if (key === null || !key.startsWith(prefix)) continue;
						const raw = storage.getItem(key);
						if (raw === null) continue;
						try {
							const parsed = recordSchema.safeParse(JSON.parse(raw));
							if (
								parsed.success &&
								key ===
									`${prefix}${parsed.data.evidenceId}:${parsed.data.txHash}`
							)
								records.push(parsed.data);
							else issue = "invalid";
						} catch {
							issue = "invalid";
						}
					}
				}
			} catch {
				issue = "unavailable";
			}
		}
		return { records: [...records], issue };
	};
	const persist = (
		evidenceId: string,
		record: DaoEvidenceRecoveryRecord | null,
	) => {
		try {
			if (prefix === null) throw new Error("INVALID_RECOVERY_SCOPE");
			if (record === null) {
				const storage = window.localStorage;
				const keys: string[] = [];
				for (let index = 0; index < storage.length; index++) {
					const key = storage.key(index);
					if (key?.startsWith(`${prefix}${evidenceId}:`)) keys.push(key);
				}
				for (const key of keys) storage.removeItem(key);
			} else
				window.localStorage.setItem(
					`${prefix}${evidenceId}:${record.txHash}`,
					JSON.stringify(record),
				);
			issue = null;
		} catch {
			issue = "unavailable";
		}
		return read();
	};
	return {
		read,
		remember(record: DaoEvidenceRecoveryRecord) {
			read();
			const valid = recordSchema.parse(record);
			records = [
				...records.filter(
					(entry) =>
						entry.evidenceId !== valid.evidenceId ||
						entry.txHash !== valid.txHash,
				),
				valid,
			];
			return persist(valid.evidenceId, valid);
		},
		forget(evidenceId: string) {
			read();
			records = records.filter((entry) => entry.evidenceId !== evidenceId);
			return persist(evidenceId, null);
		},
	};
}
