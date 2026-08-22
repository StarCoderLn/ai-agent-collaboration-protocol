import ResearchAgentLab from "@/components/agent-lab/research-agent-lab";

export default function AgentLabPage() {
	return (
		<main className="overflow-y-auto">
			<div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
				<header className="mb-8 max-w-3xl">
					<p className="font-medium text-primary text-sm">Agent Lab</p>
					<h1 className="mt-2 font-bold text-3xl tracking-tight sm:text-4xl">
						体验论文调研报告 Agent
					</h1>
					<p className="mt-3 text-muted-foreground leading-7">
						这不是静态演示：提交后会通过平台 HMAC 协议调用 Mastra
						Agent，检索真实论文， 并使用论文 Agent 当前配置的 Ollama 或 DeepSeek
						模型生成报告。
					</p>
				</header>
				<ResearchAgentLab />
			</div>
		</main>
	);
}
