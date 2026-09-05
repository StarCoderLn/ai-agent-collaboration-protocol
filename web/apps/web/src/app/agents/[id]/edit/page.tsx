import AgentConfigEditView from "@/components/agents/agent-config-edit-view";
import PageBackLink from "@/components/platform/page-back-link";

interface AgentEditPageProps {
	params: Promise<{ id: string }>;
}

export default async function AgentEditPage({ params }: AgentEditPageProps) {
	const { id } = await params;
	return (
		<main className="page-back-header mx-auto w-full max-w-7xl px-4 pb-6 sm:px-6 lg:px-12">
			{/* 返回入口独立于数据加载状态，加载中、档案不存在或请求失败时也能回到管理列表。 */}
			<PageBackLink href="/workspace/agents" label="返回我的 Agent" />
			<AgentConfigEditView agentId={id} />
		</main>
	);
}
