import AgentDetail from "@/components/platform/agent-detail";

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; return <AgentDetail agentId={id} />; }
