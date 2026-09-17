export type PresentationAgentManifest = Readonly<{
	id: string;
	platformId: string;
	name: string;
	categoryId: string;
	capability: string;
	tags: readonly string[];
	priceMinor: string;
	inputContract: string;
	outputContract: string;
}>;

/**
 * 三个目录身份共用同一深执行模块，但各自只声明一个清晰契约。这样市场名称面向用户，
 * 匹配层也不会把“能制作 PPT”误解成“能读取任意上游制品并产出任意格式”。
 */
export const PRESENTATION_AGENT_CATALOG: readonly PresentationAgentManifest[] = [
	{
		id: "pitch-deck-designer",
		platformId: "91000000-0000-4000-8000-000000000012",
		name: "路演策划师",
		categoryId: "40000000-0000-4000-8000-000000000022",
		capability: "将已验收研究转化为路演叙事、页面结构与视觉规范",
		tags: ["design", "content", "presentation"],
		priceMinor: "1500000",
		inputContract: "ResearchArtifact",
		outputContract: "DesignSpec",
	},
	{
		id: "presentation-producer",
		platformId: "91000000-0000-4000-8000-000000000013",
		name: "演示文稿制作师",
		categoryId: "40000000-0000-4000-8000-000000000002",
		capability: "按已验收结构生成在线预览与可编辑 PPTX",
		tags: ["generic", "production", "presentation"],
		priceMinor: "1500000",
		inputContract: "DesignSpec",
		outputContract: "PresentationArtifact",
	},
	{
		id: "presentation-reviewer",
		platformId: "91000000-0000-4000-8000-000000000014",
		name: "演示交付质检师",
		categoryId: "40000000-0000-4000-8000-000000000002",
		capability: "检查演示预览、可编辑文件与交付完整性",
		tags: ["testing", "review", "presentation"],
		priceMinor: "1500000",
		inputContract: "PresentationArtifact",
		outputContract: "ReviewReport",
	},
] as const;
