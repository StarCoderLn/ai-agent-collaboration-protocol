import { redirect } from "next/navigation";

export default async function TaskWorkflowPlanPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	// 旧地址曾展示一套保存在浏览器中的独立三阶段 Demo，容易被误认成正式任务已经分配的
	// Agent。保留兼容路由，但统一跳回任务详情里的权威分配图，避免两个入口解释同一概念。
	redirect(`/tasks/${id}#stage-matching`);
}
