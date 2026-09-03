import TaskExperienceDetail from "@/components/platform/task-experience-detail";

type TaskDetailPageProps = Readonly<{
	params: Promise<{ id: string }>;
	searchParams: Promise<{ from?: string | string[] }>;
}>;

export default async function TaskDetailPage({
	params,
	searchParams,
}: TaskDetailPageProps) {
	const { id } = await params;
	const { from } = await searchParams;
	// 返回目标只接受平台定义的枚举值，不能把查询参数直接当作 URL 使用，否则会形成
	// 开放重定向入口。直接打开或传入未知来源时安全回落到公开任务市场。
	const returnSource = from === "workspace" ? "workspace" : "market";
	return <TaskExperienceDetail taskId={id} returnSource={returnSource} />;
}
