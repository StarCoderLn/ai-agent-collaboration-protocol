import TaskExperienceDetail from "@/components/platform/task-experience-detail";

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <TaskExperienceDetail taskId={id} />;
}
