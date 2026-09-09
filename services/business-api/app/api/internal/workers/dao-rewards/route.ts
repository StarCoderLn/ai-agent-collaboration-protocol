import { timingSafeEqual } from "node:crypto";
import { getRequiredEnv } from "../../../../../src/config/env";
import {
	createLocalDaoRewardGrantWorker,
	createLocalDaoRewardWorker,
} from "../../../../../src/dao/dao-case-runtime";

/** 自动发奖仅由内部定时调度驱动；浏览器不能通过点击按钮冒充平台支付 Gas。 */
export async function POST(request: Request): Promise<Response> {
	const token = getRequiredEnv("DISPATCH_INTERNAL_TOKEN");
	const actual = Buffer.from(request.headers.get("authorization") ?? "");
	const expected = Buffer.from(`Bearer ${token}`);
	if (
		token.length === 0 ||
		actual.length !== expected.length ||
		!timingSafeEqual(actual, expected)
	)
		return Response.json({ error_code: "UNAUTHENTICATED" }, { status: 401 });
	try {
		const grantWorker = await createLocalDaoRewardGrantWorker();
		const grant = grantWorker === null ? null : await grantWorker.run();
		// 一次只推进一个未知 nonce。分配交易未收敛前不能继续签付款交易。
		if (grant !== null && !["idle", "confirmed"].includes(grant.status)) {
			return Response.json({ enabled: true, phase: "grant", ...grant });
		}
		const worker = await createLocalDaoRewardWorker();
		if (worker === null)
			return Response.json({
				enabled: grantWorker !== null,
				status: "not_enabled",
				grant,
			});
		return Response.json({
			enabled: true,
			phase: "payment",
			grant,
			...(await worker.run()),
		});
	} catch {
		return Response.json(
			{ error_code: "DAO_REWARD_WORKER_UNAVAILABLE" },
			{ status: 503 },
		);
	}
}
