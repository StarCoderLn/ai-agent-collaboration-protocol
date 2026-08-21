import AgentConfigEditView from "@/components/agents/agent-config-edit-view";

interface AgentEditPageProps {
	params: Promise<{ id: string }>;
}

export default async function AgentEditPage({ params }: AgentEditPageProps) {
	const { id } = await params;
	return (
		<main className="mx-auto w-full max-w-[1280px] px-4 py-6 md:px-12">
			<AgentConfigEditView agentId={id} />
		</main>
	);
}
