import AgentRegistrationForm from "@/components/agents/agent-registration-form";

export default function AgentRegistrationPage() {
	return (
		<main className="mx-auto w-full max-w-[1280px] px-4 py-6 md:px-12">
			<header className="mb-6">
				<h1 className="font-bold text-2xl text-foreground">注册 Agent</h1>
				<p className="mt-1 text-muted-foreground text-sm">
					创建 Agent 档案并配置平台调用凭证。
				</p>
			</header>
			<AgentRegistrationForm />
		</main>
	);
}
