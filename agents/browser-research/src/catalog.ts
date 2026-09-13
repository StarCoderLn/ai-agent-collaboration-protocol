/**
 * Browser Agent 在平台目录中的唯一权威定义。
 *
 * `id` 用于 Agent 协议与日志，`platformId` 用于数据库种子和跨服务引用；两者一旦进入
 * 已保存任务就不能随意修改。价格使用 USDC 最小单位字符串，避免 JavaScript 浮点数参与
 * 资金计算。服务地址只是本机开发默认值，正式部署时由注册配置覆盖。
 */
export const BROWSER_RESEARCH_AGENT = Object.freeze({
	id: "browser-research",
	platformId: "91000000-0000-4000-8000-000000000011",
	name: "网页调研助手",
	categoryId: "40000000-0000-4000-8000-000000000002",
	capability:
		"根据指定公开网页收集、核对并整理信息，交付带来源、访问时间与异常说明的结构化调研报告",
	tags: ["browser-agent", "stagehand", "web-research", "langgraph"],
	// 新 Agent 前 3 个真实结算任务受平台冷启动报价保护。1.5 USDC 与当前正式历史
	// 成交额第 30 分位一致，使内置 Agent 也遵守公共匹配门禁，不能靠种子数据绕过风控。
	priceMinor: "1500000",
	serviceEndpoint: "http://127.0.0.1:9304/run",
});
