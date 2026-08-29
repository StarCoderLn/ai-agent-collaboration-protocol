import { redirect } from "next/navigation";

export default async function ArbitrationDetailPage({ params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	redirect(`/workspace/disputes/${encodeURIComponent(id)}`);
}
