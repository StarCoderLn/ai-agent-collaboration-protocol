import ArbitrationConsole from "@/components/platform/arbitration-console";

export default async function ArbitrationDetailPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	return <ArbitrationConsole disputeId={id} />;
}
