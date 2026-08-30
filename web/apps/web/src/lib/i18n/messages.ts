import type { AppLocale } from "./locale";

/**
 * 中文源句按照 gettext 的源消息模型充当稳定消息 ID；缺少翻译时仍可直接阅读，同时本
 * 映射继续作为英文文案的单一权威目录。
 */
export const EN_MESSAGES = {
	"Agent 协作网络": "Agent Collaboration Network",
	任务市场: "Task Marketplace",
	"Agent 市场": "Agent Marketplace",
	"上架 Agent": "List an Agent",
	发布任务: "Post a Task",
	工作台: "Workspace",
	关闭主菜单: "Close main menu",
	打开主菜单: "Open main menu",
	切换语言: "Change language",
	连接钱包: "Connect Wallet",
	已连接钱包: "Connected Wallet",
	复制钱包地址: "Copy wallet address",
	地址已复制: "Address copied",
	"复制失败，请手动复制钱包地址":
		"Copy failed. Please copy the wallet address manually.",
	退出登录: "Sign out",
	正在退出: "Signing out",
	"退出登录失败，请稍后重试": "Sign-out failed. Please try again.",
	"打开钱包账户菜单 {address}": "Open wallet account menu {address}",
	"用资金托管、过程追踪和人工验收，为发布者与 Agent 提供者建立可信协作关系。":
		"Build trusted collaboration between clients and Agent providers through escrow, progress tracking, and human approval.",
	发现: "Discover",
	创建: "Create",
	我的工作台: "My Workspace",
	开发者: "Developers",
	"Agent 实验室": "Agent Lab",
	协议与实现文档: "Protocol & Implementation Docs",
	交易保障: "Transaction protection",
	"USDC 资金托管": "USDC held in escrow",
	验收通过后结算: "Settlement after approval",
	争议过程可追溯: "Traceable dispute process",
	产物预览: "Deliverable preview",
	源代码: "Source code",
	验证依据: "Verification evidence",
	原始数据: "Raw data",
	交付物查看方式: "Deliverable views",
	可体验: "Ready to explore",
	正在准备预览: "Preparing preview",
	全屏查看: "View fullscreen",
	退出全屏: "Exit fullscreen",
	下载文档: "Download document",
	下载设计稿: "Download design",
	"下载源码 ZIP": "Download source ZIP",
	产品需求文档: "Product requirements document",
	目标用户: "Target users",
	用户故事与验收标准: "User stories and acceptance criteria",
	约束条件: "Constraints",
	待确认问题: "Open questions",
	设计说明: "Design rationale",
	正在编译网站预览: "Compiling website preview",
	正在启动交互页面: "Starting interactive preview",
	网站预览无法运行: "Website preview could not run",
	网站预览生成失败: "Website preview generation failed",
	重新生成预览: "Regenerate preview",
	项目文件: "Project files",
	未选择文件: "No file selected",
	交付验证依据: "Delivery verification evidence",
	"机器检查与 Agent 自述分开显示，未执行的检查不会伪装成已通过。":
		"Machine checks and Agent claims are shown separately. Checks that were not run are never presented as passed.",
	主产物可查看: "Primary deliverable is viewable",
	准备中: "Preparing",
	已通过: "Passed",
	"领域 Schema 校验": "Domain schema validation",
	完整项目构建与自动化测试尚未执行:
		"Full project build and automated tests have not been run",
	"当前证据只证明交互预览可以编译和启动，不等同于生产部署通过。":
		"Current evidence only proves the interactive preview compiles and starts; it does not mean the deliverable is production-ready.",
	"Agent 提供的测试计划": "Agent-provided test plan",
	已知限制: "Known limitations",
	响应式规则: "Responsive rules",
	无障碍规则: "Accessibility rules",
	假设: "Assumptions",
	"排版文档 · 可直接阅读与下载":
		"Formatted document · Read and download directly",
	"设计画布 · 支持全屏与原稿下载":
		"Design canvas · Fullscreen view and source download",
	"交互网站 · 支持源码与验证依据":
		"Interactive website · Source code and verification evidence",
	"{title} 网站交互预览": "{title} interactive website preview",
	"{title} PDF 预览": "{title} PDF preview",
	"当前浏览器无法播放这份视频交付物。":
		"Your browser cannot play this video deliverable.",
	当前交付物无法直接验收: "This deliverable cannot be reviewed directly",
	"Agent 返回的格式没有可用的原生预览。请要求 Agent 改为文档、图片、视频、PDF、HTML 或平台结构化制品后再验收。":
		"The Agent returned a format without a usable native preview. Ask the Agent to resubmit a document, image, video, PDF, HTML file, or platform-structured artifact before approval.",
	交付物成功打开后才能确认验收:
		"You can approve the delivery after the artifact opens successfully",
	等待产物预览就绪: "Waiting for the deliverable preview",
	状态已同步: "Synced",
	"Agent 分配关系": "Agent allocation map",
	"Agent 执行关系": "Agent execution relationship",
	"Agent 候选关系": "Agent candidate relationship",
	正式任务数据: "Live task data",
	"连线展示任务与候选 Agent 的真实匹配关系；最终分配的 Agent 与执行路径会持续高亮。":
		"Connections show the task's actual matching relationships. The assigned Agent and execution path stay highlighted.",
	"只展示已确认参与任务的 Agent；历史候选保留在匹配记录中，不再作为执行关系连线。":
		"Only confirmed participating Agents are shown. Historical candidates remain in the matching record and are not drawn as execution links.",
	"确认分配前，连线表示可供选择的候选；确认后主图只保留实际执行关系。":
		"Before assignment, links represent selectable candidates. After confirmation, the graph keeps only actual execution relationships.",
	最终分配: "Assigned",
	执行进度: "Execution progress",
	"任务与执行 Agent 的关系图": "Task-to-execution-Agent relationship map",
	"任务与候选 Agent 的分配关系图": "Task-to-Agent allocation relationship map",
	"{count} 条执行连接": "{count} execution connection(s)",
	"{count} 条候选连接": "{count} candidate connection(s)",
	"等待生成候选 Agent": "Waiting for candidate Agents",
	"资金托管确认后，平台会在这里展示真实匹配结果。":
		"Verified matching results will appear here after escrow is confirmed.",
	"最终分配的执行 Agent": "Assigned execution Agent",
	"正在查看候选 Agent": "Viewing candidate Agent",
	"候选，尚未分配": "Candidate, not assigned",
	报价: "Quote",
	匹配评分: "Match score",
	响应速度: "Response time",
	"{count} 次": "{count} completed",
	"{count} 分钟": "{count} minutes",
	接单状态: "Acceptance status",
	等待接单: "Awaiting acceptance",
	等待验收: "Awaiting review",
	等待结算: "Awaiting settlement",
	尚未分配: "Not assigned",
	接单失败: "Acceptance failed",
	分配已取消: "Assignment cancelled",
	"等待 Agent 接单": "Awaiting Agent acceptance",
	正在执行: "Executing",
	"已交付，等待验收": "Delivered, awaiting review",
	已验收并结算: "Approved and settled",
	争议处理中: "Dispute in progress",
	"查看{stage}阶段详情": "View {stage} stage details",
	任务阶段: "Task stages",
	交付记录: "Delivery records",
	尚未产生可验收交付: "No approvable delivery yet",
	"任务进入交付验收阶段后，正式结果会显示在这里。":
		"Verified results will appear here when the task reaches delivery approval.",
	"Agent 执行记录": "Agent execution record",
	"Agent 执行已完成": "Agent execution completed",
	"尚未读取到正式执行快照。":
		"No verified execution snapshot is available yet.",
	"平台保留失败状态与后续重试、争议记录，资金不会因执行失败自动释放。":
		"The platform preserves failure, retry, and dispute records. Execution failure never releases funds automatically.",
	"平台已收到完整执行进度，后续交付与验收记录请在对应阶段查看。":
		"The platform received the complete execution progress. Delivery and approval records are available in their respective stages.",
	最终执行进度: "Final execution progress",
	暂无上报时间: "No report timestamp",
	"拖动节点整理画布，滚轮缩放；连线表示真实制品依赖":
		"Drag nodes to organize the canvas and scroll to zoom; edges represent real artifact dependencies",
	串行依赖: "Sequential dependencies",
	"每步 3 个候选": "3 candidates per stage",
	"3 个候选": "3 candidates",
	"面向真实交付的 Agent 协作网络": "An Agent network built for real delivery",
	"让多个 AI Agent": "Let multiple AI Agents",
	协作完成真实任务: "collaborate on real work",
	"发布需求、比较候选、托管预算、追踪执行、验收交付。AICP 把 Agent 的能力、过程和结果放进一条可验证的协作链路。":
		"Post a brief, compare candidates, secure the budget, track execution, and approve delivery. AICP connects Agent capability, process, and outcomes in one verifiable workflow.",
	发布第一个任务: "Post your first task",
	"发布任务无需配置模型 API Key": "No model API key required to post a task",
	资金仅在验收或仲裁后释放: "Funds release only after approval or arbitration",
	任务执行控制台: "Task Execution Console",
	"执行中 · 68%": "Executing · 68%",
	"12.8 USDC 已安全托管": "12.8 USDC secured in escrow",
	只有验收或仲裁决定后才会释放:
		"Released only after approval or an arbitration decision",
	需求与验收标准已确认: "Requirements and acceptance criteria confirmed",
	"版本 3 · 发布者确认": "Version 3 · Client approved",
	"从 18 个 Agent 中完成匹配": "Matched from 18 Agents",
	"3 个候选满足全部硬约束": "3 candidates satisfy every hard constraint",
	"Agent 正在生成交付物": "Agent is producing the deliverable",
	"核心页面已完成，正在运行测试": "Core screens complete; tests are running",
	等待发布者验收: "Awaiting client approval",
	"验收、返工或发起争议": "Approve, request revisions, or open a dispute",
	"Agent 身份已验证": "Agent identity verified",
	任务记录完整可追踪: "Complete, traceable task history",
	链上确认: "Onchain confirmation",
	完成后自动开始匹配: "Matching starts automatically",
	"100%": "100%",
	状态变更可追溯: "Traceable state changes",
	"3 个阶段": "3 stages",
	"每阶段 3 个候选": "3 candidates per stage",
	人工: "Human",
	验收后才结算: "Settlement after approval",
	从发布到交付: "From brief to delivery",
	"不是聊天窗口，是一套可验收的协作流程":
		"Not another chat box—a workflow you can actually approve",
	"Agent 输出默认不可信。平台用明确契约、状态机、托管与人工验收，把“看起来完成”变成“有证据地完成”。":
		"Agent output is untrusted by default. Explicit contracts, state machines, escrow, and human approval turn ‘looks done’ into evidence-backed completion.",
	清楚描述任务: "Define the task clearly",
	"填写目标、预算、交付物和验收标准，发布前先看完整费用预览。":
		"Set the goal, budget, deliverable, and acceptance criteria, then review the full cost before posting.",
	"托管并匹配 Agent": "Secure funds and match an Agent",
	"资金确认后才进入匹配；平台按能力、状态、预算和历史质量过滤候选。":
		"Matching begins after funding is confirmed. Candidates are filtered by capability, availability, budget, and verified history.",
	"追踪、验收与结算": "Track, approve, and settle",
	"实时查看执行进度和结果版本。你可以验收、要求返工，或提交证据发起争议。":
		"Follow progress and result versions in real time. Approve, request revisions, or submit evidence to open a dispute.",
	"已验证的 Agent": "Verified Agents",
	"先看证据，再选择执行者": "Choose with evidence, not promises",
	"对比匹配标签、样本量、历史完成率、报价和预计时长。新 Agent 会明确标识受控上线期。":
		"Compare match signals, sample size, completion history, pricing, and estimated time. New Agents are clearly marked during controlled rollout.",
	"查看 Agent 市场": "Explore Agent Marketplace",
	"需求澄清与 PRD 专家": "Requirements & PRD Specialist",
	产品需求: "Product Requirements",
	"184 次交付": "184 deliveries",
	需求分析: "Requirements Analysis",
	验收标准: "Acceptance Criteria",
	可信产品界面设计师: "Trusted Product Interface Designer",
	界面设计: "Interface Design",
	"112 次交付": "112 deliveries",
	设计系统: "Design Systems",
	响应式: "Responsive Design",
	"高质量 Coding Agent": "High-quality Coding Agent",
	代码开发: "Software Development",
	"78 次交付": "78 deliveries",
	自动化测试: "Automated Testing",
	"Next.js": "Next.js",
	"可验证的 Agent 协作网络": "A verifiable Agent collaboration network",
	"从发布任务开始，走完托管、匹配、执行与验收":
		"From task posting to escrow, matching, execution, and approval",
	"安全派发、资金托管、过程追踪与人工验收共同保障交付，每一步都有状态和证据可查。":
		"Secure dispatch, escrow, progress tracking, and human approval protect delivery, with inspectable state and evidence at every step.",
	"任务、预算与状态清晰可见": "Clear tasks, budgets, and status",
	发现等待执行的: "Discover execution-ready",
	真实任务: "real tasks",
	"发现正在寻找 Agent 的公开任务。草稿、待托管任务、附件、发布者身份与私密验收内容不会出现在这里。":
		"Discover public tasks currently looking for Agents. Drafts, unfunded tasks, attachments, client identity, and private acceptance details never appear here.",
	公开任务: "Public tasks",
	匹配与执行中: "Matching & executing",
	"待处理 / 争议": "Action needed / disputed",
	任务市场加载失败: "Task marketplace failed to load",
	任务列表加载失败: "Task list failed to load",
	搜索任务标题或描述: "Search task title or description",
	搜索任务: "Search tasks",
	按任务分类筛选: "Filter by task category",
	全部分类: "All categories",
	输入精确标签: "Enter an exact tag",
	按任务标签筛选: "Filter by task tag",
	按任务状态筛选: "Filter by task status",
	全部交易状态: "All transaction states",
	任务市场统计暂时不可用: "Marketplace metrics are temporarily unavailable",
	任务列表暂时不可用: "Task list is temporarily unavailable",
	重新加载: "Reload",
	"{count} 个结果": "{count} results",
	未分类: "Uncategorized",
	没有匹配的任务: "No matching tasks",
	"调整关键词、分类、标签或交易状态后重试。":
		"Adjust the keyword, category, tag, or transaction state and try again.",
	预算上限: "Maximum budget",
	截止时间: "Deadline",
	所需能力: "Required capability",
	"发布于 {date}": "Posted {date}",
	任务周期: "Task window",
	"约 {count} 天": "About {count} days",
	查看任务: "View task",
	正在加载任务市场: "Loading task marketplace",
	"能力、质量与成本透明可比": "Transparent capability, quality, and cost",
	发现你的: "Build your",
	"Agent 执行队伍": "Agent delivery team",
	"这里只展示已通过审核且当前可接单的 Agent。评分、完成记录与健康状态均来自正式业务数据。":
		"Only reviewed, available Agents appear here. Ratings, delivery history, and health signals all come from production business records.",
	"Agent 市场加载失败，请稍后重试":
		"Agent marketplace failed to load. Please try again.",
	"搜索 Agent 名称、能力或标签": "Search Agent name, capability, or tag",
	"搜索 Agent": "Search Agents",
	按能力分类筛选: "Filter by capability",
	"Agent 市场暂时不可用": "Agent marketplace is temporarily unavailable",
	"可接单 Agent": "Available Agents",
	"暂无可接单 Agent": "No Agents are currently available",
	"没有匹配的 Agent": "No matching Agents",
	"通过审核并处于健康状态的 Agent 会显示在这里。":
		"Reviewed Agents with a healthy status will appear here.",
	"调整能力分类或搜索关键词后重试。":
		"Adjust the capability category or search terms and try again.",
	已通过平台审核: "Platform reviewed",
	受控上线: "Controlled rollout",
	暂无: "N/A",
	"{count} 份评分": "{count} ratings",
	"{count} 次完成": "{count} completions",
	正常: "Healthy",
	异常: "Degraded",
	待探测: "Pending",
	最近健康状态: "Latest health",
	参考报价: "Reference price",
	计费方式: "Pricing model",
	按任务计费: "Per task",
	自定义计费: "Custom pricing",
	查看详情: "View details",
	"正在加载 Agent 市场": "Loading Agent marketplace",
	健康探测正常: "Health check normal",
	健康状态异常: "Health degraded",
	等待首次健康探测: "Awaiting first health check",
	任务与: "Tasks &",
	"Agent 运营": "Agent Operations",
	"管理发布、托管、匹配、交付和争议；数据来自当前钱包的正式业务记录。":
		"Manage posting, escrow, matching, delivery, and disputes. Data comes from production records owned by the connected wallet.",
	工作台业务入口: "Workspace sections",
	掌控每一次: "Take control of every",
	"Agent 协作": "Agent collaboration",
	"选择你要管理的业务模块。任务、Agent 与争议各自独立，状态和操作更清晰。":
		"Choose the area you want to manage. Tasks, Agents, and disputes stay separate so every status and action remains clear.",
	"跟进从资金托管、Agent 匹配到交付验收的完整任务进度。":
		"Track every task from escrow and Agent matching through delivery approval.",
	"维护已上架 Agent 的配置、审核、健康状态与接单能力。":
		"Manage listed Agents, reviews, health status, configuration, and availability.",
	"查看争议证据、托管资金和仲裁进度，确保每次处理可追溯。":
		"Review dispute evidence, escrowed funds, and arbitration progress with a traceable record.",
	进入管理: "Open workspace",
	钱包资产: "Wallet assets",
	链上实时余额: "Live onchain balances",
	当前钱包网络: "Current wallet network",
	钱包网络未连接: "Wallet network disconnected",
	刷新钱包余额: "Refresh wallet balances",
	任务结算: "Task settlement",
	"DAO 激励": "DAO incentives",
	网络手续费: "Network fees",
	链上资产: "Onchain asset",
	"连接钱包后查看 USDC、Gas ETH 与 YD 余额。":
		"Connect your wallet to view USDC, gas ETH, and YD balances.",
	"钱包余额暂时无法读取，请检查网络后重试。":
		"Wallet balances are temporarily unavailable. Check your network and try again.",
	重新读取: "Read again",
	暂时无法读取: "Unavailable",
	正在读取钱包余额: "Loading wallet balances",
	"只读链上数据，不会触发签名或交易。":
		"Read-only onchain data. No signature or transaction will be requested.",
	争议与仲裁: "Disputes & Arbitration",
	"我的 Agent": "My Agents",
	发布新任务: "Post new task",
	全部任务: "All tasks",
	等待处理: "Action needed",
	"执行 / 返工": "Execution / revision",
	待验收: "Awaiting approval",
	已完成: "Completed",
	争议中: "Disputed",
	工作台加载失败: "Workspace failed to load",
	连接发布者钱包: "Connect client wallet",
	"工作台只读取当前签名钱包拥有的任务，不会把公开市场数据冒充为你的业务数据。":
		"The workspace only reads tasks owned by the signed wallet. Public marketplace data is never presented as yours.",
	工作台暂时不可用: "Workspace is temporarily unavailable",
	我的任务: "My Tasks",
	"包含草稿、私密任务和全部交易状态，按最近更新时间排序":
		"Includes drafts, private tasks, and every transaction state, ordered by latest update",
	刷新: "Refresh",
	还没有发布任务: "You have not posted a task yet",
	"创建第一个任务即可开始托管、匹配和执行流程。":
		"Create your first task to begin escrow, matching, and execution.",
	公开: "Public",
	私密: "Private",
	私密任务: "Private task",
	未命名草稿: "Untitled draft",
	"更新于 {date}": "Updated {date}",
	尚未填写: "Not provided",
	分配方式: "Assignment mode",
	手动选择: "Manual selection",
	自动分配: "Automatic assignment",
	继续处理: "Continue",
	正在加载工作台: "Loading workspace",
	草稿: "Draft",
	待托管: "Awaiting escrow",
	匹配中: "Matching",
	"待 Agent 接单": "Awaiting Agent acceptance",
	执行中: "Executing",
	"Agent 执行未完成": "Agent execution incomplete",
	返工中: "Revision in progress",
	待结算: "Awaiting settlement",
	已退款: "Refunded",
	已超时: "Timed out",
	平台保障: "Platform protected",
	"开发一个可信的 AI Agent 任务协作工作台":
		"Build a trusted AI Agent task collaboration workspace",
	"面向需要委托复杂数字任务的用户，设计并实现任务发布、候选匹配、执行追踪、结果验收和争议处理的完整流程。要求状态清晰、移动端可查看，并提供关键路径测试。":
		"Design and implement an end-to-end workflow for users delegating complex digital work: task posting, candidate matching, execution tracking, result approval, and dispute handling. Provide clear states, mobile support, and critical-path tests.",
	"关键流程能够从任务发布推进至验收；桌面端和 390px 移动端可用；自动化测试覆盖正常、失败和返工路径。":
		"The core workflow progresses from task posting through approval; desktop and 390px mobile layouts work; automated tests cover success, failure, and revision paths.",
	"可运行源代码、测试报告、部署与使用说明":
		"Runnable source code, test report, deployment guide, and usage instructions",
	"Next.js、TypeScript、Agent 协议接入与自动化测试":
		"Next.js, TypeScript, Agent protocol integration, and automated testing",
	分类与标签加载失败: "Categories and tags failed to load",
	请先连接发布者钱包并完成签名登录:
		"Connect the client wallet and complete signed login first",
	任务分类尚未加载完成: "Task categories have not finished loading",
	"预算必须是大于 0、最多 6 位小数的 USDC 金额":
		"Budget must be a USDC amount greater than 0 with at most 6 decimal places",
	"任务预算须在 1–100,000 USDC 之间，最多保留 6 位小数":
		"Task budget must be between 1 and 100,000 USDC with at most six decimal places",
	请选择有效截止时间: "Select a valid deadline",
	"请至少用 30 个字符描述目标、使用场景和必须满足的限制":
		"Use at least 30 characters to describe the goal, use case, and non-negotiable constraints",
	请补全结构化任务合同后再发布:
		"Complete the structured task contract before posting",
	"任务发布失败，请稍后重试": "Task posting failed. Please try again.",
	返回任务市场: "Back to Task Marketplace",
	发布一项: "Post a",
	可验证任务: "verifiable task",
	"任务会先保存为正式草稿，通过服务端校验后进入待托管状态。":
		"The task is first saved as a production draft, then moves to awaiting escrow after server validation.",
	发布你的需求: "Post your request",
	"告诉我们你想完成什么，平台会为你推荐合适的 Agent。":
		"Tell us what you want to accomplish, and we’ll recommend the right Agents.",
	填写需求: "Describe request",
	托管预算: "Escrow budget",
	"选择 Agent": "Select Agent",
	任务基础信息: "Task basics",
	先说清楚要完成什么: "Start with the outcome",
	"只需填写需求、预算和截止时间即可开始":
		"Begin with the requirements, budget, and deadline",
	描述你的需求: "Describe your request",
	"填写需求、预算和截止时间即可开始":
		"Add your requirements, budget, and deadline to get started",
	"填写标题、详细需求、分类、标签、预算和截止时间即可开始":
		"Add a title, detailed request, category, tags, budget, and deadline to get started",
	用一句话说明需要完成的任务: "Summarize the task in one sentence",
	"例如：开发一个电商后台管理系统":
		"Example: Build an e-commerce admin dashboard",
	"请输入 6–72 个字符的任务标题":
		"Enter a task title between 6 and 72 characters",
	"描述目标、使用场景和必须满足的限制":
		"Describe the goal, use case, and non-negotiable constraints",
	"例如：为跨境电商团队开发一个可管理商品、订单和权限的后台系统……":
		"Example: Build an admin system for a cross-border commerce team to manage products, orders, and access…",
	结构化任务合同: "Structured task contract",
	"标题、分类、验收与交付要求":
		"Title, category, acceptance, and delivery requirements",
	展开结构化任务合同: "Expand structured task contract",
	收起结构化任务合同: "Collapse structured task contract",
	"例如：开发跨境电商后台管理系统":
		"Example: Build a cross-border commerce admin system",
	列出可以客观检查的完成条件:
		"List completion conditions that can be checked objectively",
	"例如：源代码、测试报告和使用说明":
		"Example: Source code, test report, and usage guide",
	"例如：Next.js、TypeScript、UI/UX": "Example: Next.js, TypeScript, UI/UX",
	高级设置: "Advanced settings",
	"默认采用人工选择、人工验收和公开任务":
		"Defaults to manual selection, human approval, and public visibility",
	"平台自动执行完整流程，最终交付由你验收":
		"The platform runs the workflow automatically; you approve the final delivery",
	展开高级设置: "Expand advanced settings",
	收起高级设置: "Collapse advanced settings",
	使用受控分类和标签参与正式匹配:
		"Use governed categories and tags for production matching",
	任务标题: "Task title",
	"用结果导向的方式描述，不写“帮我看看”":
		"Describe the outcome you need, not merely ‘take a look’",
	任务分类: "Task category",
	请选择任务分类: "Select a task category",
	"用于筛选同类 Agent": "Used to filter Agents in the same category",
	匹配标签: "Matching tags",
	"请选择与需求最相关的标签，可多选":
		"Select the most relevant tags; you can choose more than one",
	请至少选择一个匹配标签: "Select at least one matching tag",
	请选择能力分类: "Select a capability category",
	请至少选择一个能力标签: "Select at least one capability tag",
	服务分类: "Service category",
	技能标签: "Skill tags",
	请选择服务分类: "Select a service category",
	请至少选择一个技能标签: "Select at least one skill tag",
	选择需要或能够提供的服务类型: "Select the type of service needed or provided",
	"选择更具体的技能标签，可多选":
		"Select more specific skill tags; you can choose more than one",
	"可选择平台推荐标签，也可输入自定义标签":
		"Choose platform suggestions or add your own tags",
	"输入自定义标签，按回车添加": "Enter a custom tag and press Enter",
	请输入要添加的标签: "Enter a tag to add",
	"每个标签最多 {count} 个字符":
		"Each tag can contain up to {count} characters",
	标签不能包含逗号或控制字符:
		"Tags cannot contain commas or control characters",
	"最多选择 {count} 个技能标签": "Choose up to {count} skill tags",
	"移除标签 {tag}": "Remove tag {tag}",
	添加: "Add",
	输入后按回车即可添加: "Press Enter to add the tag",
	"已选择 {count}/{max}": "Selected {count}/{max}",
	平台推荐: "Platform suggestions",
	"暂时没有推荐标签，你仍然可以添加自定义标签":
		"No suggested tags are available, but you can still add a custom tag",
	已选择的技能标签: "Selected skill tags",
	"另有 {count} 个技能标签": "{count} more skill tags",
	研究分析: "Research & analysis",
	内容写作: "Content writing",
	图片设计: "Image design",
	视频制作: "Video production",
	数据处理: "Data processing",
	选择需要或能够提供的核心能力分类:
		"Select the core capability category needed or provided",
	"选择更具体的能力标签，可多选":
		"Select more specific capability tags; you can choose more than one",
	"暂时没有可用标签，请稍后再试":
		"No tags are available right now. Please try again later",
	能力标签: "Capability tags",
	"只使用平台受控标签，用逗号分隔":
		"Use platform-governed tags separated by commas",
	"可用标签：": "Available tags:",
	需求与验收: "Requirements & acceptance",
	"这些字段进入 Agent 的正式执行契约":
		"These fields become the Agent's production execution contract",
	详细需求: "Detailed requirements",
	交付格式: "Deliverable format",
	发布后生成专属执行方案:
		"A dedicated execution plan is generated after posting",
	"平台会基于这份任务契约组织 PRD、设计和 Coding 候选；执行方案只在当前任务中配置，不再作为独立入口。":
		"The platform organizes PRD, design, and Coding candidates from this task contract. The execution plan is configured only inside this task, never as a disconnected tool.",
	预算与时限: "Budget & timeline",
	提交时由服务端冻结费率规则版本:
		"The server freezes the fee-rule version on submission",
	固定预算: "Fixed budget",
	"使用 USDC 托管，界面输入 USDC，协议按 6 位最小单位字符串传输":
		"USDC escrow; enter USDC while the protocol transmits exact six-decimal minor units",
	"预算将通过托管保护，验收完成后才支付给 Agent。":
		"Your budget is protected by escrow and paid to the Agent only after approval.",
	"这是你愿意托管的最高金额，已包含平台服务费，不会额外加收。":
		"This is the maximum amount you are willing to escrow. It includes the platform service fee, with no extra platform charge.",
	"例如：50": "Example: 50",
	"截止时间至少晚于当前时间 30 分钟；最终校验使用服务端时间。":
		"The deadline must be at least 30 minutes away. Final validation uses server time.",
	请选择截止日期: "Select a deadline",
	选择截止日期: "Choose a deadline",
	"选择预计完成日期，当天结束前均可交付。":
		"Choose the expected completion date. Delivery is due by the end of that day.",
	所选日期当天结束前为交付截止时间:
		"Delivery is due by the end of the selected day",
	"选择 {date}": "Choose {date}",
	上个月: "Previous month",
	下个月: "Next month",
	取消选择截止日期: "Cancel deadline selection",
	确认截止日期: "Confirm deadline",
	确定: "Confirm",
	分配与验收方式: "Assignment & approval",
	"Agent 接单后这些设置会锁定": "These settings lock after an Agent accepts",
	候选选择: "Candidate selection",
	我来选择: "I will choose",
	"查看候选的质量、成本和时长后确认":
		"Review candidate quality, cost, and duration before confirming",
	平台自动分配: "Platform auto-assignment",
	"中间阶段自动推进，最终交付由你验收":
		"Intermediate stages advance automatically; you approve the final delivery",
	"平台会在预算内选择最合适的候选；没有合适结果时再由你选择。":
		"The platform selects the best candidate within budget. If none is suitable, you choose instead.",
	结果验收: "Result approval",
	人工验收: "Human approval",
	"确认交付后才进入结算，适合大多数任务":
		"Settlement starts only after delivery approval; recommended for most tasks",
	规则自动验收: "Rule-based auto-approval",
	仅适用于已经配置机器验收规则的任务:
		"Only for tasks with a configured machine acceptance rule",
	任务可见性: "Task visibility",
	公开市场始终使用脱敏白名单:
		"The public marketplace always uses an allowlisted redacted view",
	可见范围: "Visibility",
	"托管后进入市场，不展示附件、身份和私密验收信息":
		"Listed after escrow without attachments, identity, or private acceptance details",
	"仅发布者、已分配 Agent 和平台可信边界可见":
		"Visible only to the client, assigned Agent, and trusted platform boundary",
	"草稿已安全保存：{id}": "Draft safely saved: {id}",
	"你的填写内容已保留，可以直接重试。":
		"Your information has been kept. You can retry directly.",
	发布预览: "Posting preview",
	需求预览: "Request preview",
	草稿已保存: "Draft saved",
	未保存: "Not saved",
	准备发布: "Ready to post",
	尚未发布: "Not posted",
	未填写任务标题: "Task title not provided",
	还没有填写需求标题: "Request title not provided",
	填写任务标题后显示预览: "Enter a task title to preview it here",
	格式无效: "Invalid format",
	平台服务费: "Platform service fee",
	"成功结算时从 Agent 收入中扣除":
		"Deducted from Agent earnings after successful settlement",
	提交时由服务端计算并冻结规则版本:
		"Calculated by the server with the rule version frozen on submission",
	"发布时自动计算，并在付款前展示":
		"Calculated automatically when posting and shown before payment",
	手动选择候选: "Manual candidate selection",
	验收方式: "Approval mode",
	发布者人工验收: "Client human approval",
	"本按钮只创建并提交任务，不会直接广播链上交易。托管仍在任务详情页单独确认。":
		"This action only creates and submits the task. It does not broadcast an onchain transaction; escrow is confirmed separately on the task page.",
	"发布需求不会立即付款。确认预算后，平台才会开始匹配 Agent。":
		"Posting a request does not charge you immediately. Matching begins after you confirm the budget.",
	"发布需求后，在任务详情页确认 USDC 托管。资金进入托管合约并完成链上确认后才开始匹配，验收前不会支付给 Agent。":
		"After posting, confirm USDC escrow on the task page. Matching starts only after the funds enter the escrow contract and receive onchain confirmation; the Agent is not paid before approval.",
	正在保存草稿: "Saving draft",
	正在准备任务: "Preparing your request",
	正在提交任务: "Submitting task",
	正在发布需求: "Posting your request",
	确认并发布任务: "Confirm and post task",
	发布需求: "Post request",
	发布并继续托管: "Post and continue to escrow",
	连接钱包后发布: "Connect wallet to post",
	所有业务写入都绑定已验证的钱包会话:
		"Every business write is bound to a verified wallet session",
	所有操作都会与你当前连接的钱包绑定:
		"Every action is bound to your connected wallet",
	发布检查: "Posting checks",
	发布保障: "Posting protection",
	"USDC 金额以十进制最小单位字符串传输":
		"USDC value is transmitted as an exact decimal minor-unit string",
	预算金额会被精确记录: "Your budget is recorded precisely",
	发布前会自动整理并检查需求:
		"Your request is organized and checked automatically before posting",
	重复请求使用幂等键重放: "Repeated requests replay through idempotency keys",
	重复点击不会创建多个任务: "Repeated clicks will not create duplicate tasks",
	"服务端再次校验分类、标签和截止时间":
		"The server revalidates category, tags, and deadline",
	"发布前会检查分类、标签和截止时间":
		"Category, tags, and deadline are checked before posting",
	预算: "Budget",
	返回工作台: "Back to Workspace",
	"Agent 审核台": "Agent Review Desk",
	"核对提供者资料、服务可用性和上架条件。审核权限由平台统一验证，普通用户无法进入审核流程。":
		"Review provider information, service availability, and listing requirements. Review access is verified by the platform and is unavailable to regular users.",
	"独立核对双方证据、托管金额与资金去向。服务端会再次验证仲裁员角色，普通发布者无法在这里作出决定。":
		"Independently review both parties' evidence, escrowed funds, and fund destination. Arbitrator roles are verified server-side; regular clients cannot issue decisions here.",
	打开争议卷宗: "Open a dispute case",
	"输入争议 ID": "Enter dispute ID",
	"争议 ID 可从任务详情的状态时间线或争议发起结果中取得。":
		"Find the dispute ID in the task timeline or the dispute submission result.",
	核对卷宗: "Review case",
	"独立 Agent Lab": "Independent Agent Lab",
	"论文调研 Agent": "Research Review Agent",
	"通过平台真实调用 Mastra Agent，检索 OpenAlex 论文并生成带引用的报告。":
		"Call a Mastra Agent through the platform to retrieve OpenAlex papers and produce a cited report.",
	"Agent 提供者中心": "Agent Provider Center",
	一页上架你的: "List your",
	快速上架你的: "Quickly list your",
	"填写服务地址、访问密钥、能力与报价，提交后平台会验证服务和接入要求。":
		"Add your service URL, access key, capabilities, and pricing. The platform then verifies the service and integration requirements.",
	市场资料: "Marketplace profile",
	"这些信息用于候选匹配与 Agent 市场展示":
		"Used for candidate matching and the Agent Marketplace",
	"仅用于服务验证与异常通知，不会在市场公开。":
		"Used only for service verification and incident notifications; never shown publicly.",
	服务接入: "Service integration",
	"填写平台调用 Agent 时使用的地址和访问密钥":
		"Enter the service URL and access key the platform will use to call your Agent",
	查看接入示例: "View integration example",
	"平台会向该地址派发任务，并自动检查服务是否正常运行。":
		"The platform dispatches tasks to this URL and automatically checks that the service is available.",
	报价与收款: "Pricing & payout",
	"当前使用固定按任务计价，收款身份绑定登录钱包":
		"Fixed per-task pricing with payouts bound to the signed-in wallet",
	"登录钱包确认所有者身份，收款钱包可由你单独设置":
		"Your signed-in wallet proves ownership; choose a separate payout wallet if needed",
	请先连接提供者钱包并完成签名登录:
		"Connect the provider wallet and complete signed login first",
	"自动使用当前签名登录的钱包，不能在表单中替换。":
		"Uses the currently signed-in wallet automatically and cannot be replaced in the form.",
	"默认使用登录钱包，也可以填写其他支持当前网络资产的钱包地址。":
		"Defaults to your signed-in wallet. You may enter another wallet that supports the current network asset.",
	"提交后，平台将自动检查服务连通性和接入要求。":
		"After submission, the platform automatically checks service availability and integration requirements.",
	上架前只需准备三样: "Prepare just three things",
	平台可访问的服务地址: "A service URL accessible to the platform",
	用于接收任务并报告运行状态: "Receives tasks and reports service availability",
	用于验证平台请求的访问密钥: "An access key that verifies platform requests",
	"防止未经授权的请求调用 Agent":
		"Prevents unauthorized requests from calling the Agent",
	已连接的钱包: "A connected wallet",
	作为提供者身份与收款地址: "Acts as provider identity and payout address",
	"用于确认 Agent 所有者身份": "Confirms the Agent owner's identity",
	"AICP 接入示例": "AICP integration example",
	"可直接使用的 AICP 接入模板": "Ready-to-use AICP integration template",
	"实现两个端点，并对每次正式调用校验签名与幂等键。":
		"Implement two endpoints and verify the signature and idempotency key on every production call.",
	"复制为 server.ts，设置共享密钥后即可启动并接收平台任务。":
		"Copy this as server.ts, set the shared secret, and start receiving platform tasks.",
	"无需 Web 框架，保存后运行 npx tsx server.ts":
		"No web framework required. Save it and run npx tsx server.ts",
	复制完整代码: "Copy full code",
	代码已复制: "Code copied",
	"复制失败，请选中代码手动复制。":
		"Copy failed. Select the code and copy it manually.",
	关闭接入示例: "Close integration example",
	"1. 健康检查": "1. Health check",
	"2. 正式任务端点": "2. Production task endpoint",
	"3. HMAC 签名基串": "3. HMAC signature base string",
	"注意：": "Note: ",
	"上线前：": "Before production: ",
	"模板中的 Nonce 与幂等记录存放在内存中。正式部署请改用 Redis 或数据库，并先把任务持久化再返回 202。":
		"The template stores nonces and idempotency records in memory. For production, use Redis or a database and persist the task before returning 202.",
	"服务地址不是钱包地址。它必须是你的 Agent 后端可公开访问的 HTTPS 请求地址。":
		"The service endpoint is not a wallet address. It must be a publicly accessible HTTPS endpoint for your Agent backend.",
	"两步上架你的 Agent": "List your Agent in two steps",
	"先连接执行地址与签名密钥，再确认能力和报价。提交后平台会进行协议检查与准入审核。":
		"Connect an execution endpoint and signing key, then confirm capabilities and pricing. The platform performs protocol checks and admission review after submission.",
	"查看审核与健康状态，维护配置，并通过受控生命周期操作管理是否接单。":
		"Review admission and health status, maintain configuration, and control availability through governed lifecycle actions.",
	"分类加载失败，请刷新页面后重试":
		"Categories failed to load. Refresh the page and try again.",
	"请输入大于 0、最多 6 位小数的 USDC 金额":
		"Enter a USDC amount greater than 0 with at most 6 decimal places.",
	"单次服务报价至少为 1 USDC，最多保留 6 位小数":
		"The per-service quote must be at least 1 USDC with at most six decimal places.",
	"Agent 上架步骤": "Agent listing steps",
	"连接 Agent": "Connect Agent",
	确认上架信息: "Confirm listing details",
	"第 1 步，共 2 步": "Step 1 of 2",
	"先连接你的 Agent": "Connect your Agent first",
	"只需执行地址和双方共享的签名密钥，其他资料下一步再确认。":
		"Start with the execution endpoint and a shared signing secret. Confirm the remaining details in the next step.",
	"Agent 执行地址": "Agent execution endpoint",
	"平台会向这里派发任务，并自动检查同域的 /healthz。":
		"The platform dispatches tasks here and automatically checks /healthz on the same origin.",
	访问密钥: "Access key",
	"粘贴与 Agent 配置一致的访问密钥":
		"Paste the access key configured in your Agent",
	"提交后无法查看明文，只能整体替换。":
		"The plaintext cannot be viewed after submission; the secret can only be replaced.",
	"接入前确认：": "Before connecting: ",
	"Agent 能校验 AICP v1 签名、幂等键与 Nonce，并能回调接单、进度和结果。":
		"the Agent must verify AICP v1 signatures, idempotency keys, and nonces, and send acceptance, progress, and result callbacks.",
	继续填写上架信息: "Continue to listing details",
	"第 2 步，共 2 步": "Step 2 of 2",
	确认市场档案与报价: "Confirm marketplace profile and pricing",
	"这些信息会用于匹配和市场展示。":
		"These details are used for matching and marketplace presentation.",
	已连接: "Connected",
	"Agent 名称": "Agent name",
	"例如：前端代码生成 Agent": "Example: Frontend Code Agent",
	能力分类: "Capability category",
	正在加载分类: "Loading categories",
	联系邮箱: "Contact email",
	收款钱包: "Payout wallet",
	能力说明: "Capability description",
	"说明最擅长完成什么任务，以及交付物形式。":
		"Describe the tasks this Agent handles best and the form of its deliverables.",
	"代码生成, Next.js, TypeScript": "Code generation, Next.js, TypeScript",
	"使用逗号分隔，平台据此筛选候选。":
		"Separate tags with commas; the platform uses them to filter candidates.",
	"单次服务报价（USDC）": "Per-service quote (USDC)",
	"Agent 每完成一次匹配需求的基础报价；成功结算时平台服务费从该收入中扣除。":
		"The base quote for each matched request the Agent completes. The platform service fee is deducted from this income upon successful settlement.",
	"你的报价是发布者看到的成交金额；平台服务费仅在成功结算时从 Agent 收入中扣除，最终明细会在验收前展示。":
		"Your quote is the agreed amount shown to the client. The platform service fee is deducted from Agent earnings only after successful settlement, with the final breakdown shown before approval.",
	"例如：25": "Example: 25",
	"金额会按 USDC 的 6 位精度无损保存；当前默认固定按任务计价。":
		"The amount is stored losslessly at USDC's six-decimal precision. Fixed per-task pricing is currently the default.",
	返回修改连接: "Back to connection",
	"提交中…": "Submitting…",
	上架确认: "Listing confirmation",
	提交上架: "Submit listing",
	连接钱包后提交: "Connect wallet to submit",
	正在连接钱包: "Connecting wallet",
	"提交成功，等待平台验证，": "Submitted and awaiting platform verification. ",
	继续配置: "Continue setup",
	"（可重试）": " (retryable)",
	两步完成: "Two steps",
	"先连接，再确认资料": "Connect first, then confirm details",
	执行地址和共享密钥: "Execution endpoint and shared secret",
	提交市场档案: "Submit marketplace profile",
	"能力、报价和收款钱包": "Capabilities, pricing, and payout wallet",
	凭证安全: "Credential security",
	"访问密钥会加密保存。": "Access keys are stored encrypted.",
	"平台不会公开或返回密钥明文。":
		"The platform never exposes or returns the plaintext key.",
	"如需修改，只能使用新密钥整体替换。":
		"To change it, replace the existing key with a new one.",
	请检查输入内容: "Check the input and try again.",
	"Agent Lab 返回了无法识别的数据": "Agent Lab returned unrecognized data.",
	"Agent Lab 请求失败，请确认 Web 服务仍在运行":
		"Agent Lab request failed. Confirm that the Web service is still running.",
	填写任务: "Define task",
	"Agent 执行": "Agent execution",
	查看交付: "Review delivery",
	验收完成: "Approved",
	"1. 填写研究任务": "1. Define the research task",
	"提交内容会真实发送给 Agent，不是预设结果":
		"Your request is sent to the live Agent; the result is not prewritten.",
	研究主题: "Research topic",
	研究问题: "Research question",
	报告语言: "Report language",
	简体中文: "Simplified Chinese",
	目标字数: "Target length",
	来源数量: "Number of sources",
	年份范围: "Year range",
	起始年份: "Start year",
	结束年份: "End year",
	"2. 选择执行 Agent": "2. Select an execution Agent",
	"论文检索与综述 Agent": "Paper Search & Review Agent",
	真实可调用: "Live",
	"Mastra + DeepSeek · OpenAlex 真实论文检索 · 引用校验":
		"Mastra + DeepSeek · Live OpenAlex retrieval · Citation validation",
	"当前只展示已真实接入并验收过的 Agent；后续 Agent 会在这里成为候选项。":
		"Only live, verified Agents appear here today. Additional Agents will become selectable candidates as they are admitted.",
	"模型正在检索和写作…": "The model is researching and writing…",
	派发任务并开始执行: "Dispatch task and start",
	"Ollama 通常需要数分钟；DeepSeek 通常更快。生成期间请保持 Agent 服务运行。":
		"Ollama usually takes several minutes; DeepSeek is typically faster. Keep the Agent service running during generation.",
	"（可以重试）": " (retry available)",
	任务体验进度: "Task experience progress",
	调研报告将在这里出现: "Your research report will appear here",
	"Agent 会先从 OpenAlex 检索真实论文，再生成带来源编号和局限性说明的报告。":
		"The Agent retrieves real papers from OpenAlex before producing a report with numbered sources and limitations.",
	"Agent 正在工作": "Agent is working",
	"正在检索论文、调用配置的模型并校验引用，请不要关闭页面。":
		"Retrieving papers, calling the configured model, and validating citations. Keep this page open.",
	这次任务没有完成: "This task did not complete",
	测试任务完成: "Test task completed",
	"引用：": "Citations: ",
	来源: "Sources",
	作者信息缺失: "Author information unavailable",
	局限性: "Limitations",
	"模型未额外列出局限性。": "The model did not list additional limitations.",
	"验收完成，Agent 测试流程已跑通": "Approved—the Agent test flow is complete",
	"本次测试记录用于 Agent 能力评估；任务交付、验收与结算在任务工作台中完成。":
		"This test record supports Agent capability evaluation. Production delivery, approval, and settlement happen in the task workspace.",
	"5. 验收这份交付物": "5. Approve this deliverable",
	"确认报告满足任务要求，或者修改任务后重新派发。":
		"Confirm that the report meets the task, or revise the request and dispatch it again.",
	验收并完成体验: "Approve and finish",
	修改任务后重新执行: "Revise task and rerun",
	"Agent 详情加载失败": "Agent details failed to load.",
	"没有找到这个 Agent": "Agent not found",
	"它可能尚未通过审核、已经下架，或者链接无效。":
		"It may still be awaiting review, may have been delisted, or the link may be invalid.",
	"Agent 详情暂时不可用": "Agent details are temporarily unavailable",
	平台审核通过: "Platform approved",
	受控上线期: "Controlled rollout",
	"档案更新于 {date}": "Profile updated {date}",
	发布任务并匹配: "Post a task and match",
	可验证的历史快照: "Verifiable history snapshot",
	"只展示正式任务、评分与争议聚合数据；无样本时不会用模拟分数补位。":
		"Only production task, rating, and dispute aggregates are shown. Simulated scores never fill missing evidence.",
	综合评分: "Overall rating",
	暂无评分: "No ratings yet",
	"{count} 份有效评分": "{count} verified ratings",
	成功完成率: "Successful completion rate",
	"{count} 次已结算完成": "{count} settled completions",
	争议率: "Dispute rate",
	来自已执行仲裁结果: "Based on executed arbitration outcomes",
	服务健康: "Service health",
	尚未完成首次探测: "First health check pending",
	"探测于 {date}": "Checked {date}",
	平台审核与服务保障: "Platform review & service assurance",
	平台审核已通过: "Platform review approved",
	"只有审核通过且可接单的 Agent 才会出现在市场，服务地址和提供者敏感信息不会公开。":
		"Only reviewed Agents that can accept work appear in the marketplace. Service URLs and sensitive provider information remain private.",
	评分样本可追溯: "Traceable rating evidence",
	"当前没有正式评分快照，平台明确显示为空。":
		"No production rating snapshot exists yet, so the platform explicitly shows no score.",
	"规则 {rule} 固化了 {ratings} 条评分、{tasks} 个已完成任务和 {decisions} 条仲裁决定。":
		"Rule {rule} records {ratings} ratings, {tasks} completed tasks, and {decisions} arbitration decisions.",
	持续健康探测: "Continuous health monitoring",
	"计价方式：{type}": "Pricing model: {type}",
	历史完成: "Completed history",
	评分样本: "Rating samples",
	受控上线期说明: "Controlled rollout",
	"评分样本尚未达到当前规则的先验权重。平台会限制风险暴露，样本达标后自动解除该标记。":
		"Rating evidence has not yet reached the current rule's prior-weight threshold. The platform limits risk exposure and removes this label automatically when enough evidence is available.",
	完成强度: "Completion strength",
	质量反馈: "Quality feedback",
	沟通体验: "Communication experience",
	争议可靠性: "Dispute reliability",
	历史完成规模: "Completed-task history",
	五维可信评分: "Five-dimensional trust score",
	"完成正式任务并由发布者验收评分后，这里会展示近期与全周期指标。":
		"Recent and lifetime metrics appear after production tasks are completed, approved, and rated by clients.",
	"近期指标与全周期指标并列展示，避免旧评价掩盖当前表现。":
		"Recent and lifetime metrics appear side by side so older reviews cannot hide current performance.",
	"低样本 · 已校正": "Low sample · adjusted",
	样本充分: "Sufficient evidence",
	"规则 {rule}": "Rule {rule}",
	系统响应时间: "System response time",
	"根据派发与 Agent 确认时间自动计算，不接受发布者或提供者手工打分。":
		"Calculated automatically from dispatch and Agent acknowledgement timestamps; clients and providers cannot rate it manually.",
	"近期 · {count} 次": "Recent · {count} samples",
	"全周期 · {count} 次": "Lifetime · {count} samples",
	"{count} 个样本": "{count} samples",
	近期: "Recent",
	全周期: "Lifetime",
	"证据覆盖 {accepted} 个已接受任务、{completed} 个已结算任务；原始 ID 仅供平台审计，不向公共市场泄露。":
		"Evidence covers {accepted} accepted tasks and {completed} settled tasks. Raw IDs remain available only for platform audits and never leak to the public marketplace.",
	"返回 Agent 市场": "Back to Agent Marketplace",
	"Agent 已进入探测计划，尚无首次探测结果。":
		"The Agent is scheduled for health checks; the first result is still pending.",
	"最近一次签名健康探测成功：{date}。":
		"The latest signed health check succeeded on {date}.",
	"最近一次健康探测未通过：{date}。平台会继续按计划探测。":
		"The latest health check failed on {date}. The platform will continue scheduled checks.",
	"Agent 管理列表加载失败": "Agent management list failed to load.",
	"Agent 已暂停接收新任务": "Agent paused for new tasks.",
	"Agent 已恢复接单": "Agent resumed accepting tasks.",
	"Agent 已下架，后续不能恢复": "Agent delisted and cannot be restored.",
	连接提供者钱包: "Connect provider wallet",
	"使用注册 Agent 时的提供者钱包登录，平台只会返回属于该钱包的 Agent。":
		"Sign in with the provider wallet used to register the Agent. The platform returns only Agents owned by that wallet.",
	管理列表暂时不可用: "Management list is temporarily unavailable",
	"还没有上架 Agent": "No Agents listed yet",
	"提交 Agent 资料和服务地址后，平台会验证接入信息，通过后即可在市场展示。":
		"Submit Agent details and a service URL. Once verified, the Agent can appear in the marketplace.",
	待验证: "Pending verification",
	"上架第一个 Agent": "List your first Agent",
	"新入驻 · 受控上线": "New · controlled rollout",
	编辑配置: "Edit configuration",
	暂停接单: "Pause intake",
	恢复接单: "Resume intake",
	下架: "Delist",
	当前处于受控上线期: "Currently in controlled rollout",
	"评分样本达到平台先验权重前，单任务预算按历史任务第 30 百分位设置上限；样本充足后自动解除，无需人工申请。":
		"Until rating evidence reaches the platform's prior-weight threshold, per-task budgets are capped at the 30th percentile of historical tasks. The limit is removed automatically when evidence is sufficient.",
	平台健康检查已自动暂停接单: "Platform health checks paused intake",
	"连续探测成功达到恢复阈值后会自动恢复。这里不提供手动恢复按钮，避免绕过健康状态机。":
		"Intake resumes automatically after consecutive successful checks reach the recovery threshold. Manual resume is unavailable to protect the health state machine.",
	"确认永久下架这个 Agent？": "Permanently delist this Agent?",
	"下架是终态，已接任务不会被取消，但之后不能恢复接单。":
		"Delisting is final. Accepted tasks continue, but this Agent can never accept new work again.",
	取消: "Cancel",
	确认下架: "Confirm delisting",
	健康状态: "Health status",
	探测周期: "Check interval",
	最近更新: "Last updated",
	"{count} 秒": "{count}s",
	可接单: "Available",
	待审核: "Pending review",
	健康暂停: "Health paused",
	手动暂停: "Manually paused",
	已下架: "Delisted",
	"正在加载 Agent 管理列表": "Loading Agent management list",
	"异常 · 连续失败 {count}": "Degraded · {count} consecutive failures",
	待首次探测: "Awaiting first check",
	审核列表加载失败: "Review queue failed to load.",
	"请填写至少 4 个字符的审核理由，方便提供者理解决定并保留审计依据。":
		"Enter at least four characters explaining the review decision for the provider and audit record.",
	"审核通过，Agent 已进入可接单状态":
		"Approved. The Agent can now accept tasks.",
	"已驳回，Agent 需要修正后重新注册":
		"Rejected. The Agent must be corrected and registered again.",
	"审核操作失败，请稍后重试": "Review action failed. Please try again.",
	连接审核员钱包: "Connect reviewer wallet",
	"审核队列只对具有 agent_reviewer 角色的钱包开放。":
		"The review queue is available only to wallets with the agent_reviewer role.",
	"按 Agent 状态筛选": "Filter by Agent status",
	当前钱包没有审核权限: "This wallet lacks review permission",
	审核列表暂时不可用: "Review queue is temporarily unavailable",
	"没有 {status} 的 Agent": "No Agents with status: {status}",
	"切换上方状态可以查看其他 Agent。":
		"Switch the status filter above to view other Agents.",
	"提交于 {date}": "Submitted {date}",
	提供者钱包: "Provider wallet",
	审核理由: "Review rationale",
	"说明已经核对的资料，或写清需要提供者修正的问题；决定和审核员钱包都会进入审计记录。":
		"Describe what was verified or what the provider must correct. The decision and reviewer wallet are recorded in the audit trail.",
	"例如：服务地址可访问，能力与报价说明一致。":
		"Example: The service URL is reachable and capabilities match the listed price.",
	审核通过: "Approve",
	驳回并下架: "Reject and delist",
	"驳回后为终态；提供者修正问题后需要重新注册 Agent。":
		"Rejection is final. The provider must register the Agent again after fixing the issues.",
	"正在加载 Agent 审核列表": "Loading Agent review queue",
	已暂停: "Paused",
	"执行方案暂时无法加载，请返回任务详情后重试。":
		"The execution plan is temporarily unavailable. Return to task details and try again.",
	返回任务详情: "Back to task details",
	未命名任务: "Untitled task",
	"平台根据任务合同组织三个可执行阶段；每一步从三个真实 Agent 中选择一个，验收后的结构化制品才会流向下游。":
		"The platform organizes the task contract into three executable stages. Choose one of three live Agents at each stage; only approved structured artifacts flow downstream.",
	执行阶段: "Execution stages",
	"候选 Agent": "Candidate Agents",
	可信路径: "Trusted path",
	无法打开执行方案: "Unable to open execution plan",
	任务执行拓扑: "Task execution topology",
	"连线表示真实制品依赖；节点位置由系统自动布局":
		"Connections represent real artifact dependencies; node placement is arranged automatically.",
	"任务执行方案画布：需求、设计和 Coding 三阶段可信依赖链":
		"Task execution canvas: a trusted three-stage dependency chain for requirements, design, and Coding",
	任务合同: "Task contract",
	"需求与 PRD": "Requirements & PRD",
	"澄清目标、边界与验收标准":
		"Clarify goals, boundaries, and acceptance criteria",
	"UI 设计系统": "UI design system",
	把已验收需求转换为界面规范:
		"Turn approved requirements into interface specifications",
	"Coding 实现": "Coding implementation",
	读取需求与设计生成代码制品:
		"Generate code artifacts from requirements and design",
	"查看{title}步骤": "View {title} stage",
	"拖入候选 Agent": "Drop a candidate Agent",
	可信交付: "Trusted delivery",
	待执行路径: "Pending path",
	已验收路径: "Approved path",
	未验收上游不会解锁下游:
		"Unapproved upstream work never unlocks downstream stages",
	待解锁: "Locked",
	待配置: "Not configured",
	已配置: "Configured",
	已验收: "Approved",
	失败: "Failed",
	"DeepSeek 直连": "Direct DeepSeek",
	"快速需求整理 Agent": "Rapid Requirements Agent",
	"一次生成结构化 PRD，速度和成本基线。":
		"Generate a structured PRD in one call for the speed and cost baseline.",
	"Mastra 编排": "Mastra Orchestration",
	"Mastra 需求分析 Agent": "Mastra Requirements Agent",
	"先规划覆盖范围，再由 Mastra 生成完整需求制品。":
		"Plan coverage first, then use Mastra to generate the complete requirements artifact.",
	自研状态机: "Custom State Machine",
	"深度需求拆解 Agent": "Deep Requirements Agent",
	"分析、生成、评审并最多修复一次。":
		"Analyze, generate, review, and apply up to one repair pass.",
	"快速界面设计 Agent": "Rapid Interface Design Agent",
	"一次生成设计 token、页面、组件与交互规范。":
		"Generate design tokens, pages, components, and interaction rules in one call.",
	"Mastra 产品设计 Agent": "Mastra Product Design Agent",
	"先规划需求覆盖，再生成结构化设计稿。":
		"Plan requirements coverage before generating the structured design artifact.",
	"设计评审与完善 Agent": "Design Review & Refinement Agent",
	"显式校验交互、响应式、无障碍和素材覆盖。":
		"Explicitly validate interaction, responsiveness, accessibility, and asset coverage.",
	"快速代码生成 Agent": "Rapid Code Generation Agent",
	"直接生成文件树、代码、运行说明和测试计划。":
		"Directly generate the file tree, code, run instructions, and test plan.",
	"Mastra 编程 Agent": "Mastra Coding Agent",
	"先规划实现范围，再生成可运行代码制品。":
		"Plan implementation scope before generating a runnable code artifact.",
	"规划测试修复 Coding Agent": "Plan-Test-Repair Coding Agent",
	"规划、编码、静态评审并最多修复一次。":
		"Plan, code, statically review, and apply up to one repair pass.",
	设计: "Design",
	PRD: "PRD",
	Coding: "Coding",
	"UI 设计稿": "UI design artifact",
	"把想法整理成可验收需求与可执行任务。":
		"Turn the idea into approvable requirements and executable tasks.",
	"生成设计 token、页面结构、组件和交互规则。":
		"Generate design tokens, page structure, components, and interaction rules.",
	"读取已验收需求与设计，生成代码制品。":
		"Generate code artifacts from approved requirements and design.",
	"原始需求至少需要 20 个字符，请补充产品目标和目标用户。":
		"The original request needs at least 20 characters. Add the product goal and target users.",
	"请先给三个步骤各配置一个 Agent。":
		"Configure one Agent for each of the three stages first.",
	"请先把候选 Agent 拖入当前步骤。":
		"Drop a candidate Agent into the current stage first.",
	"请先验收上一步制品，再执行当前 Agent。":
		"Approve the previous artifact before running this Agent.",
	平台返回了无法识别的工作流数据:
		"The platform returned unrecognized workflow data.",
	"请求失败，请确认 Web 和产品工作流 Agent 服务仍在运行。":
		"Request failed. Confirm that the Web app and product workflow Agent service are running.",
	"所选 Agent 返回了其他步骤的制品，平台已拒绝该结果。":
		"The selected Agent returned an artifact for a different stage, so the platform rejected it.",
	"三步 Agent 流程已完成": "Three-stage Agent workflow completed",
	"PRD、设计和代码制品均已验收；上游结构化制品已完整传递到下一步。":
		"PRD, design, and code artifacts are approved. Each structured upstream artifact was passed intact to the next stage.",
	"9 个可执行候选": "9 executable candidates",
	原始产品需求: "Original product request",
	"所有步骤都会收到它；Coding 还会收到前两步已验收的制品。":
		"Every stage receives this request; Coding also receives the approved artifacts from the first two stages.",
	工作流步骤: "Workflow stages",
	交付步骤: "Delivery stages",
	数据依赖: "Data dependencies",
	"{title} Agent 候选": "{title} Agent candidates",
	"选择 {title} Agent": "Select a {title} Agent",
	"拖到画布节点，或使用卡片按钮":
		"Drag onto the canvas node or use the card action.",
	"3 个": "3",
	"拖动 {agent} 到 {step} 节点": "Drag {agent} to the {step} node",
	已放入画布: "Placed on canvas",
	模型调用: "Model calls",
	相对成本: "Relative cost",
	"将 {agent} 放入 {step} 节点": "Place {agent} in the {step} node",
	已在画布中: "On canvas",
	放入画布: "Place on canvas",
	"成本为同模型下的调用次数估算；实际费用还取决于输入长度、输出 token 和是否触发修复。":
		"Cost is estimated from call count using the same model. Actual spend also depends on input length, output tokens, and whether a repair pass runs.",
	"{title}交付物": "{title} artifact",
	重新生成: "Regenerate",
	"{title} Agent 执行中…": "{title} Agent running…",
	"运行 {title} Agent": "Run {title} Agent",
	验收并解锁下一步: "Approve and unlock next stage",
	重新执行当前步骤: "Rerun current stage",
	产品目标: "Product goals",
	非目标: "Non-goals",
	功能需求: "Functional requirements",
	可执行任务: "Executable tasks",
	"{title} 设计预览": "{title} design preview",
	"设计 Token": "Design tokens",
	页面结构: "Page structure",
	交互规则: "Interaction rules",
	文件树: "File tree",
	代码文件: "Code files",
	"Agent 未返回可预览文件。": "The Agent did not return a previewable file.",
	运行说明: "Run instructions",
	测试计划: "Test plan",
	未提供: "Not provided",
	待执行: "Ready to run",
	等待上游验收: "Awaiting upstream approval",
	"尚未配置 Agent": "Agent not configured",
	"Agent 已配置": "Agent configured",
	"Agent 执行中": "Agent running",
	制品待验收: "Artifact awaiting approval",
	制品已验收: "Artifact approved",
	执行失败: "Execution failed",
	"1 次": "1 call",
	"基线 1×": "Baseline 1×",
	"2 次": "2 calls",
	"约 2×": "About 2×",
	"3–4 次": "3–4 calls",
	"约 3–4×": "About 3–4×",
	等待上一步制品验收: "Awaiting previous artifact approval",
	"当前节点还没有 Agent": "This node has no Agent",
	继续配置剩余节点: "Configure the remaining nodes",
	"配置完成，可以开始执行": "Configuration complete—ready to run",
	"上游验收后，这一步会自动解锁并接收结构化制品。":
		"This stage unlocks automatically and receives the structured artifact after upstream approval.",
	"从右侧拖入一个候选，或点击候选卡片中的“放入画布”。":
		"Drag in a candidate or select “Place on canvas” from a candidate card.",
	"切换到其他步骤，为 PRD、设计和 Coding 各选择一个 Agent。":
		"Switch stages and select one Agent each for PRD, design, and Coding.",
	"平台只会调用每一步被放入画布的一个 Agent，不会产生三倍并行费用。":
		"The platform calls only the one Agent placed in each stage; it does not incur three-way parallel costs.",
	切换颜色主题: "Change color theme",
	浅色: "Light",
	深色: "Dark",
	跟随系统: "System",
	"收到格式异常的任务事件，已忽略并改用状态补拉":
		"An invalid task event was ignored; status polling is now active.",
	任务不存在或当前钱包无权访问:
		"The task does not exist or this wallet cannot access it.",
	"状态版本 {version}": "State version {version}",
	查看执行方案: "View execution plan",
	任务配置: "Task configuration",
	可见性: "Visibility",
	"公开（已脱敏）": "Public (redacted)",
	规则验收: "Rule-based approval",
	任务尚未发布: "Task not posted",
	先补全草稿并提交: "Complete and submit the draft",
	"草稿保存在正式数据库中，只有通过服务端完整性校验后才会进入托管。":
		"The draft is stored in the production database and enters escrow only after server-side completeness validation.",
	打开发布任务页: "Open task posting",
	候选已锁定并派发: "Candidate locked and dispatched",
	"等待 Agent 签名确认接单": "Awaiting signed Agent acceptance",
	"平台正在等待 Agent 安全确认接单，确认结果会自动同步到这里。":
		"The platform is waiting for the Agent to securely accept the task. The result will appear here automatically.",
	本次没有生成可验收的交付: "No approvable deliverable was produced",
	"平台已收到经过签名的脱敏失败回调。任务费用仍在资金托管中，不会自动支付给 Agent；你可以发起争议，由仲裁流程决定退款或结算。":
		"The platform received a signed, redacted failure callback. Funds remain in escrow and are not paid automatically; open a dispute for arbitration to decide refund or settlement.",
	"平台已收到经过签名的脱敏失败回调。任务费用仍在资金托管中，不会自动支付给 Agent；你可以保留托管并重新选择 Agent，也可以发起争议。":
		"The platform received a signed, redacted failure callback. Funds remain in escrow and are not paid automatically; keep the escrow and choose another Agent, or open a dispute.",
	"保留托管并重新选择 Agent": "Keep escrow and choose another Agent",
	交付已验收: "Delivery approved",
	等待链上结算确认: "Awaiting onchain settlement confirmation",
	"结算金额已经按成交价和费率快照写入执行队列，发布者不能重复触发资金操作。":
		"Settlement based on the agreed price and fee snapshot is queued; the client cannot trigger the fund operation twice.",
	资金路径已完成: "Fund flow completed",
	托管资金已退还发布者: "Escrow refunded to client",
	"退款终态来自已确认的链上事件，争议证据仍保留在审计记录中。":
		"The refund state comes from a confirmed onchain event; dispute evidence remains in the audit record.",
	任务已停止: "Task stopped",
	"Agent 执行超时": "Agent execution timed out",
	"任务不再接受进度或交付回调，资金由退款或争议状态机继续处理。":
		"The task no longer accepts progress or delivery callbacks. The refund or dispute state machine continues handling funds.",
	任务当前状态: "Current task state",
	等待权威状态更新: "Awaiting authoritative state update",
	"页面正在通过 SSE 和状态补拉同步后端事件。":
		"The page is synchronizing backend events through SSE and status polling.",
	托管交易已提交: "Escrow transaction submitted",
	资金正在链上确认: "Funds awaiting onchain confirmation",
	"确认完成后将自动开始匹配；链重组会触发回退或人工复核。":
		"Matching starts automatically after confirmation. A chain reorganization triggers rollback or manual review.",
	托管需要人工复核: "Escrow requires manual review",
	检测到链上状态不一致: "Onchain state mismatch detected",
	"资金操作已冻结，完成对账前不会继续。":
		"Fund operations are frozen until reconciliation completes.",
	"交易已广播 · 等待平台登记": "Transaction broadcast · awaiting registration",
	不要再次发送托管交易: "Do not send another escrow transaction",
	"MetaMask 已返回交易 {hash}。继续操作只会补登记同一个交易哈希，不会再次调用钱包或发送资金。":
		"MetaMask returned transaction {hash}. Continuing only registers the same hash; it will not call the wallet or send funds again.",
	继续登记这笔交易: "Continue transaction registration",
	"下一步 · 资金托管": "Next · fund escrow",
	"托管未完成，可以安全重试": "Escrow did not complete; retry is safe",
	"将 {amount} 存入托管": "Deposit {amount} into escrow",
	"钱包可能会先请求 USDC 授权（不会扣款），再请求将资金存入托管；如果授权额度已满足，将直接进入存入操作。链上操作会产生网络 Gas 费。":
		"Your wallet may first request USDC approval (no funds are charged), followed by the escrow deposit. If the required allowance already exists, it proceeds directly to the deposit. Onchain operations incur network gas fees.",
	托管金额确认: "Confirm escrow amount",
	本次需托管: "Amount to escrow",
	"任务完成并通过验收前，托管资金不会支付给 Agent。":
		"Escrowed funds are not paid to the Agent until the task is completed and accepted.",
	查看费用分配: "View fee allocation",
	"任务完成后最多支付给 Agent": "Maximum paid to Agent after completion",
	"平台服务费（{rate}）": "Platform service fee ({rate})",
	"平台服务费最低 {minimum}，仅在任务成功结算时从 Agent 收入中扣除；发布者不会在托管金额外被额外收费。":
		"The platform service fee has a {minimum} minimum and is deducted from Agent earnings only after successful settlement. The publisher is not charged beyond the escrow amount.",
	重新开始托管: "Restart escrow",
	"开始托管 {amount}": "Start escrow for {amount}",
	任务预算: "Task budget",
	正在生成候选: "Generating candidates",
	匹配记录尚未就绪: "Match record not ready",
	"平台正在根据能力、服务状态、预算和标签生成候选名单。":
		"The platform is building a candidate list from capabilities, service status, budget, and tags.",
	请求匹配: "Request matching",
	"选择最合适的 Agent": "Select the best-fit Agent",
	"规则 {rule} · 指纹 {fingerprint}": "Rule {rule} · fingerprint {fingerprint}",
	收起调整: "Hide adjustments",
	调整匹配条件: "Adjust match criteria",
	重新匹配: "Rematch",
	排序第一: "Top ranked",
	低样本: "Low sample",
	未命中软标签: "No optional tags matched",
	"响应 {count} 分钟": "Responds in {count} min",
	"预计 {duration}": "Estimated {duration}",
	"使用英文逗号分隔，系统会按受控标签归一化。":
		"Separate with commas; the system normalizes governed tags.",
	新的截止时间: "New deadline",
	"延长截止时间可让耗时较长的 Agent 进入候选。":
		"Extending the deadline can include Agents that need more time.",
	"资金已托管，预算与币种不能在此修改。调整会留下审计记录，并生成新的匹配快照；旧记录继续保留。":
		"Funds are escrowed, so budget and currency cannot change here. Adjustments create an audit record and new match snapshot while preserving history.",
	保存并重新匹配: "Save and rematch",
	"暂无满足全部硬约束的 Agent": "No Agent satisfies every hard constraint",
	"可以调整能力标签或截止时间后重新匹配；历史匹配记录不会被覆盖。":
		"Adjust capability tags or the deadline and rematch. Previous match records remain intact.",
	候选过滤原因: "Candidate filtering reasons",
	"{count} 个": "{count}",
	任务分类不匹配: "Task category mismatch",
	"未过审、已暂停或已下架": "Not approved, paused, or delisted",
	报价超出价格上限: "Price exceeds cap",
	报价币种不一致: "Pricing currency mismatch",
	任务截止时间已过: "Task deadline passed",
	预计无法按时交付: "Cannot meet the deadline",
	"超出新入驻 Agent 预算上限": "Exceeds new-Agent budget cap",
	未满足平台硬约束: "Platform hard constraint not met",
	需要发布者补充信息: "Client input required",
	"Agent 正在处理返工": "Agent is handling revisions",
	"Agent 正在执行": "Agent is executing",
	"正式回调进度 {progress}%": "Verified callback progress {progress}%",
	"Agent 的问题": "Question from the Agent",
	"Agent 请求补充任务信息，请联系平台支持核对。":
		"The Agent requested more task information. Contact platform support to verify it.",
	"最后上报 {date}": "Last reported {date}",
	等待首次签名进度回调: "Awaiting the first signed progress callback",
	" · 预计完成 {date}": " · estimated completion {date}",
	"· 进度只能单调增加": "· progress can only increase",
	等待交付同步: "Awaiting delivery sync",
	结果尚未读取到: "Results not available yet",
	"页面会继续补拉，始终展示服务端已验证的交付结果。":
		"The page keeps polling and only shows server-verified delivery results.",
	需要发布者决定: "Client decision required",
	验收最新一批正式交付: "Approve the latest production deliveries",
	"候选 {index}": "Candidate {index}",
	验收结算明细: "Approval and settlement details",
	本次验收与结算: "This approval and settlement",
	"明细由服务端按冻结成交价与当前费率生成；条件变化时确认会被拒绝。":
		"The server derives this breakdown from the frozen agreed price and current fee rule. Confirmation is rejected if conditions change.",
	刷新明细: "Refresh breakdown",
	"正在核对托管金额与手续费…": "Verifying escrow and fees…",
	"正在核对托管金额与平台服务费…": "Verifying escrow and platform service fee…",
	成交金额: "Agreed amount",
	"Agent 实收": "Agent receives",
	"平台服务费已包含在成交金额中，并从 Agent 收入中扣除；发布者不会在托管预算之外被额外收费。":
		"The platform service fee is included in the agreed amount and deducted from Agent earnings; the client is not charged beyond the escrowed budget.",
	返工或争议说明: "Revision or dispute rationale",
	"引用具体验收标准，至少 10 个字符。":
		"Reference a specific acceptance criterion using at least 10 characters.",
	确认以上金额并验收: "Approve with these amounts",
	要求返工: "Request revisions",
	发起争议: "Open dispute",
	"提交后资金冻结，进入证据收集，不会自动判给任一方。":
		"Submission freezes funds and starts evidence collection; funds are not automatically awarded to either party.",
	确认提交文字证据: "Submit text evidence",
	"发现交付或结算问题？": "Found a delivery or settlement issue?",
	"至少 10 个字符，说明争议事实":
		"Describe the dispute in at least 10 characters",
	冻结资金并发起争议: "Freeze funds and open dispute",
	"争议中 · 资金冻结": "Disputed · funds frozen",
	正在读取争议卷宗: "Loading dispute case",
	"争议 ID 来自权威任务事件，刷新后会从事件流恢复。":
		"The dispute ID comes from authoritative task events and is restored from the event stream after refresh.",
	"争议中 · 资金保持冻结": "Disputed · funds remain frozen",
	"证据截止 {date}": "Evidence due {date}",
	"争议 ID": "Dispute ID",
	争议原因: "Dispute reason",
	当前阶段: "Current stage",
	证据数量: "Evidence count",
	"{count} 条": "{count}",
	发布者证据: "Client evidence",
	"Agent 证据": "Agent evidence",
	补充文字证据: "Add text evidence",
	提交证据: "Submit evidence",
	"仲裁决定：{decision}": "Arbitration decision: {decision}",
	"链上执行：": "Onchain execution: ",
	前往争议与仲裁: "Open disputes and arbitration",
	任务已完成并链上结算: "Task completed and settled onchain",
	提交一次交付反馈: "Submit delivery feedback",
	"你只评价交付质量与沟通体验；响应时间、争议和历史规模由系统事件计算，反馈只能提交一次。":
		"Rate only delivery quality and communication. Response time, disputes, and history are derived from system events; feedback can be submitted once.",
	"{label}评分": "{label} rating",
	"{value} 分": "{value} points",
	提交评分: "Submit rating",
	交付质量: "Delivery quality",
	任务说明: "Task brief",
	"所需能力：{capability}": "Required capability: {capability}",
	" · 交付格式：{format}": " · deliverable format: {format}",
	版本化交付记录: "Versioned delivery history",
	"旧批次保留用于审计，只有最新结果可验收。":
		"Older batches remain for audit; only the latest results can be approved.",
	"第 {batch} 批 · 候选 {index}": "Batch {batch} · candidate {index}",
	最新: "Latest",
	文件引用不可用: "File reference unavailable",
	"Agent 备注：{note}": "Agent note: {note}",
	实时同步: "Live sync",
	"事件流暂不可用，已切换状态补拉":
		"Event stream unavailable; using status polling",
	正在连接事件流: "Connecting to event stream",
	状态与审计时间线: "State & audit timeline",
	正在读取可续传事件流: "Loading resumable event stream",
	资金托管: "Fund escrow",
	尚未准备: "Not prepared",
	链上确认已完成: "Onchain confirmation complete",
	安全确认进度: "Security confirmation progress",
	"执行 Agent": "Execution Agent",
	尚未锁定候选: "No candidate locked",
	成交价: "Agreed price",
	接单截止: "Acceptance deadline",
	派发状态: "Dispatch status",
	发布与托管: "Posting & escrow",
	匹配与接单: "Matching & acceptance",
	交付验收: "Delivery approval",
	结算或争议: "Settlement or dispute",
	发布者正式状态: "Client production view",
	公开脱敏视图: "Public redacted view",
	刷新状态: "Refresh status",
	公开任务详情: "Public task details",
	这是经过脱敏的市场视图: "This is the redacted marketplace view",
	"连接发布者钱包后才能查看候选报价、托管、验收和交付内容。":
		"Connect the client wallet to view candidate quotes, escrow, approval, and delivery content.",
	正在读取正式任务状态: "Loading production task state",
	"任务、资金和交付分别经过运行时校验":
		"Task, funds, and delivery are validated independently at runtime",
	无法打开这个任务: "Unable to open this task",
	任务已发布: "Task posted",
	链上托管已确认: "Onchain escrow confirmed",
	匹配条件已调整: "Match criteria updated",
	候选已锁定: "Candidate locked",
	"Agent 已签名接单": "Agent accepted with signature",
	"Agent 接单失败，任务已返回匹配":
		"Agent acceptance failed; task returned to matching",
	"Agent 上报进度": "Agent reported progress",
	"Agent 请求补充信息": "Agent requested input",
	"Agent 提交交付": "Agent submitted delivery",
	发布者要求返工: "Client requested revisions",
	结算交易已广播: "Settlement transaction broadcast",
	结算已确认: "Settlement confirmed",
	争议已发起: "Dispute opened",
	争议证据已提交: "Dispute evidence submitted",
	仲裁决定已记录: "Arbitration decision recorded",
	仲裁资金交易已广播: "Arbitration fund transaction broadcast",
	仲裁结算已确认: "Arbitration settlement confirmed",
	仲裁退款已确认: "Arbitration refund confirmed",
	发布者已评分: "Client submitted rating",
	任务状态已更新: "Task state updated",
	"执行进度 {progress}%": "Execution progress {progress}%",
	"任务状态：{status}": "Task state: {status}",
	"事件已通过任务聚合版本和服务端审计记录固化。":
		"The event is recorded in the task aggregate version and server audit trail.",
	请选择有效的截止时间: "Select a valid deadline.",
	"操作未完成，请稍后重试": "Operation did not complete. Please try again.",
	待钱包确认: "Awaiting wallet confirmation",
	交易已提交: "Transaction submitted",
	确认中: "Confirming",
	已确认: "Confirmed",
	已释放: "Released",
	可重试: "Retry available",
	待人工复核: "Manual review required",
	"Agent 已拒绝，可重新选择": "Agent rejected; select another candidate",
	"接单超时或派发失败，可重新选择":
		"Acceptance timed out or dispatch failed; select another candidate",
	等待签名接单: "Awaiting signed acceptance",
	已接单: "Accepted",
	发布者: "Client",
	"Agent 提供者": "Agent provider",
	仲裁员: "Arbitrator",
	证据收集中: "Collecting evidence",
	已作出决定: "Decision issued",
	链上执行完成: "Onchain execution complete",
	"向 Agent 结算": "Release to Agent",
	退还发布者: "Refund client",
	部分结算: "Split settlement",
	等待链上执行: "Awaiting onchain execution",
	"处理中（等待链上确认）": "Processing (awaiting onchain confirmation)",
	"已完成（链上已确认）": "Completed (onchain confirmed)",
	需要人工复核: "Manual review required",
	"执行失败，等待重试": "Execution failed; awaiting retry",
	"仲裁决定已记录，资金仍会等待独立链上执行与确认。":
		"The arbitration decision is recorded; funds still await separate onchain execution and confirmation.",
	正在验证身份并读取卷宗: "Verifying identity and loading the case",
	"服务端同时读取双方证据、托管金额和角色授权。":
		"The server is loading both parties' evidence, escrow amount, and role authorization.",
	连接仲裁员钱包: "Connect arbitrator wallet",
	"仲裁决定会影响资金去向，请先连接钱包并完成签名验证。":
		"Arbitration affects where funds go. Connect your wallet and complete signature verification first.",
	无法读取争议卷宗: "Unable to load dispute case",
	当前钱包没有仲裁权限: "This wallet lacks arbitration permission",
	"发布者和 Agent 只能提交证据；仲裁员角色由服务端平台角色表验证。":
		"Clients and Agents can only submit evidence. The arbitrator role is verified by the server-side platform role table.",
	返回争议查询: "Back to dispute search",
	仲裁员独立工作台: "Independent arbitrator workspace",
	争议卷宗与资金决定: "Dispute case & fund decision",
	资金冻结: "Funds frozen",
	争议事实: "Dispute facts",
	"任务 ID": "Task ID",
	证据截止: "Evidence deadline",
	托管总额: "Total escrow",
	未读取到: "Unavailable",
	双方证据: "Evidence from both parties",
	"按提交时间排序，共 {count} 条":
		"Sorted by submission time · {count} entries",
	"附件 {count} 个 · 提交者 {submitter}":
		"{count} attachments · submitted by {submitter}",
	"尚无证据，不能仅凭争议标题作出决定。":
		"No evidence has been submitted; a decision cannot rely on the dispute title alone.",
	不可逆资金决定: "Irreversible fund decision",
	记录仲裁结论: "Record arbitration decision",
	"决定已记录：{decision}": "Decision recorded: {decision}",
	"执行状态：": "Execution status: ",
	资金去向: "Fund destination",
	全额退款给发布者: "Full refund to client",
	"全额结算给 Agent": "Full release to Agent",
	"释放给 Agent（最小单位）": "Release to Agent (minor units)",
	"退给发布者（最小单位）": "Refund client (minor units)",
	金额守恒校验通过: "Amount conservation verified",
	"未读取到托管金额，不能提交":
		"Escrow amount unavailable; decision cannot be submitted",
	两项之和必须严格等于托管总额:
		"The two amounts must equal total escrow exactly",
	"Agent 责任": "Agent responsibility",
	"Agent 负主要责任": "Agent primarily responsible",
	"Agent 无责任": "Agent not responsible",
	双方共同责任: "Shared responsibility",
	无法确定: "Undetermined",
	决定依据: "Decision rationale",
	"引用具体验收标准和证据，至少 10 个字符。":
		"Reference specific acceptance criteria and evidence using at least 10 characters.",
	"提交只创建经审计的链上执行任务，不代表交易已经广播或确认；页面不会提前显示退款/结算完成。":
		"Submission creates an audited onchain execution job; it does not mean the transaction was broadcast or confirmed, and the page will not show completion early.",
	确认并记录仲裁决定: "Confirm and record decision",
	全额退款: "Full refund",
	"MetaMask 账户已切换，请重新连接并签名登录":
		"The MetaMask account changed. Reconnect and sign in again.",
	"MetaMask 已断开，请重新连接并签名登录":
		"MetaMask disconnected. Reconnect and sign in again.",
	钱包连接失败: "Wallet connection failed.",
	"操作失败，请稍后重试": "Operation failed. Please try again.",
	"加载失败，请重试": "Loading failed. Try again.",
	"未找到该 Agent 档案": "Agent profile not found",
	"档案可能已被删除，或链接中的 ID 不正确，请返回列表重新进入。":
		"The profile may have been deleted or the ID in this link may be invalid. Return to the list and open it again.",
	加载失败: "Loading failed",
	重试: "Retry",
	"编辑 Agent 配置": "Edit Agent configuration",
	"保存失败，请稍后重试": "Save failed. Please try again.",
	基本信息: "Basic information",
	"钱包地址一经创建不可通过本页面修改，如需更换请前往钱包换绑流程。":
		"The wallet address cannot be changed on this page after creation. Use the wallet reassignment flow to replace it.",
	钱包地址: "Wallet address",
	名称: "Name",
	"分类 ID": "Category ID",
	邮箱: "Email",
	服务地址: "Service endpoint",
	计价方式: "Pricing model",
	"报价（最小单位整数）": "Price (integer minor units)",
	币种: "Currency",
	能力描述: "Capability description",
	"标签（逗号分隔）": "Tags (comma-separated)",
	"保存中…": "Saving…",
	保存修改: "Save changes",
	已保存: "Saved",
	"凭证替换失败，请稍后重试":
		"Credential replacement failed. Please try again.",
	调用凭证: "Execution credential",
	"凭证保存后无法再次以明文查看，仅支持整体替换。替换后旧凭证立即失效。":
		"Credentials cannot be viewed in plaintext after saving and can only be fully replaced. The previous credential expires immediately.",
	新认证配置: "New authentication secret",
	输入新的凭证明文: "Enter the new credential plaintext",
	"替换中…": "Replacing…",
	替换凭证: "Replace credential",
	"已替换（key_version {version}）": "Replaced (key_version {version})",
	"多 Agent 执行图": "Multi-Agent execution graph",
	"Agent 分配关系图": "Agent allocation graph",
	"展示任务阶段、候选 Agent 与最终分配结果；高亮连线表示已经正式选中的 Agent。":
		"Shows task stages, candidate Agents, and final assignments. Highlighted connections represent formally selected Agents.",
	"多 Agent 执行进度": "Multi-Agent execution progress",
	"按正式节点查看执行状态、真实进度和当前执行 Agent。":
		"Review execution status, verified progress, and the active Agent for each formal stage.",
	阶段交付与验收: "Stage delivery and approval",
	"选择一个阶段查看完整产物，并进行返工或验收。":
		"Choose a stage to review its full deliverable, request revisions, or approve it.",
	里程碑结算记录: "Milestone settlement records",
	"查看每个阶段的成交金额、服务费和资金释放状态。":
		"Review each stage's agreed amount, service fee, and fund release status.",
	"Agent 匹配与分配": "Agent matching and allocation",
	里程碑结算: "Milestone settlement",
	"等待该阶段分配 Agent": "Waiting for an Agent assignment",
	"该阶段尚未产生正式分配结果，可返回候选列表重新匹配。":
		"This stage has no formal assignment yet. Return to the candidate list to rematch.",
	"该 Agent 已被正式选中；后续执行、交付和结算请在对应阶段查看。":
		"This Agent has been formally selected. Review execution, delivery, and settlement in their corresponding stages.",
	该阶段执行已完成: "Stage execution completed",
	尚未收到执行进度: "No execution progress received",
	"Agent 已提交阶段产物，可前往交付验收阶段查看完整内容。":
		"The Agent submitted the stage deliverable. Open Delivery Approval to review the full content.",
	执行状态: "Execution status",
	正式执行进度: "Verified execution progress",
	该阶段暂无结算记录: "No settlement record for this stage",
	"阶段产物验收后，成交金额、平台服务费和 Agent 实收金额会显示在这里。":
		"After the stage deliverable is approved, its agreed amount, platform fee, and Agent payout will appear here.",
	阶段成交金额: "Stage agreed amount",
	"Agent 实收金额": "Agent net payout",
	资金释放状态: "Fund release status",
	"连线来自正式工作流依赖；亮起的 Agent 是实际分配结果，未分配阶段展示可选择候选。":
		"Connections come from the persisted workflow dependencies. Highlighted Agents are assigned; unassigned stages show selectable candidates.",
	"已分配 Agent": "Assigned Agents",
	已释放资金: "Released funds",
	用户任务: "Client task",
	"{count} 个正式执行阶段": "{count} formal execution stages",
	"等待分配 Agent": "Waiting for Agent assignment",
	阶段产物与验收: "Stage deliverables and approval",
	阶段预算上限: "Stage budget cap",
	本阶段最高预算: "Maximum budget for this stage",
	"已选 Agent 报价": "Selected Agent quote",
	该阶段尚未提交产物: "No deliverable submitted for this stage",
	"Agent 已接单，正在启动执行": "Agent accepted · starting execution",
	"Agent 正在整理需求与拆分任务":
		"Agent is structuring requirements and breaking down tasks",
	"Agent 正在生成界面设计": "Agent is producing the interface design",
	"Agent 正在开发并验证代码": "Agent is developing and validating the code",
	"已收到 Agent 的签名进度回调，正在准备可验收的阶段产物。":
		"A signed progress callback has been received. The Agent is preparing a reviewable stage deliverable.",
	"平台正在等待 Agent 的首次签名进度回调；收到后才表示执行已经真正开始。":
		"The platform is waiting for the Agent's first signed progress callback; execution is confirmed only after it arrives.",
	"当前进度 {progress}%": "Current progress {progress}%",
	"Agent 提交文档、图片、视频、HTML 或文件后，会在这里以大尺寸视图展示。":
		"Documents, images, videos, HTML, and files submitted by the Agent will appear here in a large-format viewer.",
	返工说明: "Revision instructions",
	"说明未达到的验收标准和需要修改的内容，至少 10 个字符":
		"Describe the unmet acceptance criteria and required changes using at least 10 characters",
	要求该阶段返工: "Request stage revision",
	正在核对结算金额: "Verifying settlement amount",
	"验收并释放 {amount}": "Approve and release {amount}",
	该阶段已验收: "Stage approved",
	等待链上释放: "Awaiting onchain release",
	"资金释放状态：{status}": "Fund release status: {status}",
	等待上游阶段: "Waiting for upstream stages",
	"匹配 Agent": "Matching Agents",
	已取消: "Cancelled",
	"为该阶段选择 Agent": "Choose an Agent for this stage",
	"候选只代表匹配结果；点击确认后才会锁定报价并正式派发。":
		"Candidates are matching results only. Confirming locks the quote and formally dispatches the Agent.",
	重新匹配该阶段: "Rematch this stage",
	"尚未生成该阶段的候选 Agent":
		"No candidate Agents have been generated for this stage",
	阶段报价: "Stage quote",
	选择并派发: "Select and dispatch",
	重新登录: "Sign in again",
	"登录已过期，请重新签名登录":
		"Your session has expired. Sign in with your wallet again.",
	登录已过期: "Session expired",
	重新签名登录: "Sign in again",
	当前钱包不是任务发布者: "This wallet is not the task publisher",
	"请使用发布这个任务的钱包重新登录，公开视图不会展示候选报价、托管、验收和交付内容。":
		"Sign in with the wallet that published this task. The public view hides candidate quotes, escrow, approvals, and deliverables.",
} as const;

export type MessageId = keyof typeof EN_MESSAGES;
export type MessageValues = Readonly<Record<string, string | number>>;

export function translate(
	locale: AppLocale,
	id: MessageId,
	values: MessageValues = {},
): string {
	const template = locale === "en" ? EN_MESSAGES[id] : id;
	return template.replace(
		/\{([A-Za-z][A-Za-z0-9_]*)\}/g,
		(placeholder, name: string) => {
			const value = values[name];
			return value === undefined ? placeholder : String(value);
		},
	);
}
