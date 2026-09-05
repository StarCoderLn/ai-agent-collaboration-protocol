import type { Route } from "next";

import TransactionDetail from "@/components/platform/transaction-detail";

const TASK_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type TransactionPageProps = Readonly<{
	params: Promise<{ hash: string }>;
	searchParams: Promise<{
		taskId?: string | string[];
		disputeId?: string | string[];
		source?: string | string[];
	}>;
}>;

/**
 * 返回入口只接受预定义的业务上下文，任务与争议 ID 还必须是合法 UUID。不能直接接受
 * returnUrl，否则公开的交易详情页会变成开放重定向入口。直接访问时回落到任务市场。
 */
export default async function TransactionPage({
	params,
	searchParams,
}: TransactionPageProps) {
	const [{ hash }, query] = await Promise.all([params, searchParams]);
	const taskId =
		typeof query.taskId === "string" && TASK_ID_PATTERN.test(query.taskId)
			? query.taskId
			: null;
	const disputeId =
		typeof query.disputeId === "string" && TASK_ID_PATTERN.test(query.disputeId)
			? query.disputeId
			: null;
	const fromDao = query.source === "dao";
	// 所有动态 ID 都已通过 UUID 白名单校验；这里仅恢复 typedRoutes 无法从运行时校验
	// 推导出的类型。优先返回最具体的争议卷宗，其次是任务或 DAO 上下文。
	const returnTarget =
		disputeId !== null
			? {
					href: `/workspace/disputes/${disputeId}` as Route,
					label: "返回争议卷宗" as const,
				}
			: taskId !== null
				? {
						href: `/tasks/${taskId}?from=workspace` as Route,
						label: "返回任务详情" as const,
					}
				: fromDao
					? { href: "/dao" as Route, label: "返回 DAO 仲裁" as const }
					: { href: "/tasks" as Route, label: "返回任务市场" as const };
	return (
		<TransactionDetail
			hash={hash}
			returnHref={returnTarget.href}
			returnLabel={returnTarget.label}
		/>
	);
}
