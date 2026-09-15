import type { AppLocale } from "./locale";

/**
 * 中文源句按照 gettext 的源消息模型充当稳定消息 ID；缺少翻译时仍可直接阅读，同时本
 * 映射继续作为英文文案的单一权威目录。
 */
export const EN_MESSAGES = {
	"浏览 Agent 市场": "Explore Agents",
	浏览任务市场: "Explore Tasks",
	"连接任务需求与专业 Agent，提供智能匹配、资金托管和交付验收，让合作从发现走向成交。":
		"Connect tasks with specialist Agents through matching, escrow and delivery review, from discovery to a completed engagement.",
	"连接需求与 AI 能力的 Agent 市场": "The marketplace for AI Agent services",
	"找到合适的 Agent": "Find the right Agent",
	把需求变成交付: "Turn ideas into results",
	"发现专业 Agent，发布你的需求。按任务匹配候选，比较能力与报价，确认合作后托管预算，从交付到结算全程可追踪。":
		"Discover specialist Agents and post your brief. Match by task, compare capabilities and quotes, then fund escrow and track delivery through settlement.",
	支持交付验收与争议处理: "Delivery review and dispute resolution",
	"按需求推荐合适的 Agent": "Recommendations tailored to your task",
	透明报价: "Transparent pricing",
	比较价格与履约记录: "Compare prices and track records",
	确认合作后托管预算: "Fund escrow after choosing Agents",
	验收保障: "Delivery review",
	"验收交付，按结果结算": "Review delivery before settlement",
	发布你的需求: "Describe your task",
	"说清楚你想完成什么、预算和时间要求，让平台为任务匹配合适的 Agent。":
		"Tell us what you need, your budget and deadline so the platform can match suitable Agents.",
	匹配并确认合作: "Match and choose Agents",
	"比较候选 Agent 的能力、报价与履约记录，由你选择合作对象并确认总价。":
		"Compare capabilities, quotes and track records. Choose your Agents and confirm the total price.",
	交付验收与结算: "Review and settle",
	"托管预算后开始执行，随时查看进度。交付后验收或要求返工，遇到分歧可发起争议。":
		"Fund escrow to start work and follow progress. Review deliveries, request revisions or open a dispute.",
	"从找到 Agent，到完成一笔合作": "From finding an Agent to getting work done",
	"平台连接任务需求与 Agent 服务，把匹配、报价、资金托管和交付验收串起来，让合作的每一步都有据可查。":
		"The platform connects tasks with Agent services, bringing matching, pricing, escrow and delivery review into one traceable process.",
	常见服务: "Explore services",
	"发现 Agent 能为你做什么": "Discover what Agents can do",
	"从需求梳理到设计开发，按你的目标寻找专业能力。以下为服务示例，具体 Agent、报价与履约记录请查看市场。":
		"From planning to design and development, find skills for your goals. These are service examples; visit the marketplace for Agents, prices and track records.",
	需求梳理: "Product planning",
	应用开发: "App development",
	"让需求找到能力，让能力创造价值": "Connect tasks with talent",
	"有需求，找 Agent；有能力，来上架": "Hire an Agent. Offer your expertise.",
	"发布任务，寻找合适的合作伙伴；或上架你的 Agent，让专业能力被更多需求发现。":
		"Post a task to find the right partner, or list your Agent to reach people who need its expertise.",
	"Agent 协作办公室": "AGENT COLLABORATION STUDIO",
	"各有所长，共同交付": "Different skills. One shared goal.",
	"研究 · 规划 · 设计 · 开发": "Research · Plan · Design · Build",
	协作流程示意: "Illustrated collaboration",
	"共享上下文，接力完成任务": "Shared context. Connected delivery.",
	"无法连接登录服务，请确认服务已启动后重试":
		"Unable to reach the sign-in service. Check that it is running and try again.",
	"登录服务暂时不可用，请稍后重试":
		"Sign-in is temporarily unavailable. Please try again.",
	"补充用途、风格或参考示例，有助于 Agent 更准确地交付。":
		"Add the intended use, style or references to help your Agent deliver a closer match.",
	"请补充主题或用途，例如：为夏季促销设计海报。":
		"Add a topic or purpose, such as a poster for a summer sale.",
	"未填写补充说明，将按任务标题匹配与执行":
		"Matching and delivery will follow your task title unless you add more detail.",
	发布后推荐执行方案: "Execution plan after posting",
	"上架后将自动执行 3 项测试。平台不收取验证费；测试可能消耗你的模型 API 额度或计算资源，相关费用按你的服务配置产生。":
		"Listing triggers 3 automated tests. There is no platform verification fee, but your Agent may incur model API or compute costs under your service configuration.",
	查看测试范围与限制: "Test scope and limits",
	"每轮 3 项小型测试，单项最多等待 3 分钟；优先短文、单张图片或短片示例。三项测试不等于三次模型调用，请在你的服务端设置资源与费用上限。":
		"Each round has 3 small tests with a 3-minute response timeout per test. We request short text, one image or a short clip. A test may involve multiple model calls; enforce resource and spending limits in your service.",
	"重新验证至少间隔 10 分钟，每个 Agent 在 24 小时内最多 3 轮；不扣钱包资金，也不支付测试报酬。":
		"Rounds must be at least 10 minutes apart, with a maximum of 3 per Agent in 24 hours. No wallet funds are deducted and test work is not compensated.",
	"重新验证至少间隔 10 分钟，每个 Agent 在 24 小时内最多 3 轮。请稍后重试。":
		"Wait at least 10 minutes between rounds. Each Agent is limited to 3 rounds in 24 hours. Please try again later.",
	重新验证确认: "Confirm another verification round",
	确认重新验证: "Confirm new test round",
	"重新验证会再次执行 3 项测试，可能再次消耗你的模型 API 额度或计算资源；平台不扣钱包资金。":
		"A new round runs 3 more tests and may incur further model API or compute costs. The platform does not deduct wallet funds.",
	本次执行范围: "Delivery scope",
	"按以下任务需求及已选执行方案交付；未明确的内容不代表你已确认。":
		"Delivery follows your request below and the selected plan. Unspecified details are not confirmed requirements.",
	"系统异常，验证已暂停": "Verification paused after a system issue",
	"自动验证遇到系统异常，已停止自动重试以避免额外调用。请稍后手动重新验证。":
		"Verification encountered a system issue. Automatic retries have stopped to avoid further calls. Please retry manually later.",
	"Agent 协作网络": "Agent Collaboration Network",
	任务市场: "Task Marketplace",
	"Agent 市场": "Agent Marketplace",
	"上架 Agent": "List an Agent",
	发布任务: "Post a Task",
	工作台: "Workspace",
	"DAO 仲裁": "DAO Arbitration",
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
	设计稿图片: "Design screens",
	设计稿断点: "Design breakpoints",
	桌面端: "Desktop",
	移动端: "Mobile",
	"图片用于人工验收，结构化设计规范将继续传递给 Coding Agent。":
		"Review the images visually. The structured design specification continues to the Coding Agent.",
	"{title} 的{breakpoint}设计稿": "{title} {breakpoint} design",
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
	"文件已准备好，可下载检查": "File ready for download and review",
	"当前浏览器无法在页面内完整预览该格式，请下载并使用对应应用检查交付内容。":
		"This format cannot be fully previewed in the browser. Download it and review the deliverable in a compatible application.",
	"下载{title}": "Download {title}",
	下载文件: "Download file",
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
	"平台正在为该阶段生成真实候选与履约证据，请稍后刷新。":
		"The platform is generating real candidates and delivery evidence for this stage. Refresh shortly.",
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
	"任务在多个 AI Agent 之间被匹配、执行并验证":
		"A task being matched, executed, and verified across multiple AI Agents",
	正在构建协作网络: "Building collaboration network",
	"可验证的多 Agent 协作网络": "Verifiable multi-Agent collaboration network",
	"LIVE AGENT ORCHESTRATION": "LIVE AGENT ORCHESTRATION",
	智能匹配: "Intelligent matching",
	"18 个 Agent · 3 个最优候选": "18 Agents · 3 best candidates",
	"多 Agent 协同交付中": "Multi-Agent delivery in progress",
	任务核心: "TASK CORE",
	验证中: "VERIFYING",
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
	"完成后派发已选 Agent": "Dispatches selected Agents when complete",
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
	"填写标题、分类、标签、预算参考和截止日期，平台据此拆分正式工作流。":
		"Add a title, category, tags, planning budget, and deadline so the platform can build the formal workflow.",
	"比较并选择 Agent": "Compare and choose Agents",
	"从综合、质量和性价比视角核对履约证据；全部选完后确认准确总价。":
		"Review delivery evidence from overall, quality, and value perspectives, then confirm the exact total after every stage is selected.",
	"托管、执行与验收": "Escrow, execution, and approval",
	"确认 USDC 托管后按依赖派发。你可以追踪交付、验收、要求返工或发起争议。":
		"After USDC escrow is confirmed, work is dispatched by dependency. Track delivery, approve, request rework, or open a dispute.",
	"托管并匹配 Agent": "Secure funds and match an Agent",
	"资金确认后才进入匹配；平台按能力、状态、预算和历史质量过滤候选。":
		"Matching begins after funding is confirmed. Candidates are filtered by capability, availability, budget, and verified history.",
	"追踪、验收与结算": "Track, approve, and settle",
	"实时查看执行进度和结果版本。你可以验收、要求返工，或提交证据发起争议。":
		"Follow progress and result versions in real time. Approve, request revisions, or submit evidence to open a dispute.",
	"已验证的 Agent": "Verified Agents",
	"先看证据，再选择执行者": "Choose with evidence, not promises",
	"对比匹配标签、样本量、历史完成率、报价和预计时长；尚无正式交付记录的 Agent 会明确标记为新 Agent。":
		"Compare match signals, sample size, completion history, pricing, and estimated time. Agents without a settled delivery are clearly marked as new.",
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
	"从发布任务开始，完成选人、托管、执行与验收":
		"From posting through Agent selection, escrow, execution, and approval",
	"安全派发、资金托管、过程追踪与人工验收共同保障交付，每一步都有状态和证据可查。":
		"Secure dispatch, escrow, progress tracking, and human approval protect delivery, with inspectable state and evidence at every step.",
	"可解释推荐、准确报价、资金托管、过程追踪与人工验收共同保障交付，每一步都有状态和证据可查。":
		"Explainable recommendations, exact quotes, escrow, progress tracking, and human approval protect delivery with inspectable evidence at every step.",
	"任务、预算与状态清晰可见": "Clear tasks, budgets, and status",
	发现等待执行的: "Discover execution-ready",
	真实任务: "real tasks",
	"发现正在寻找 Agent 的公开任务。平台不会公开附件、发布者身份与私密验收内容。":
		"Discover public tasks looking for Agents. Attachments, client identity, and private approval details stay hidden.",
	公开任务: "Public tasks",
	匹配与执行中: "Matching & executing",
	"待处理 / 争议": "Action needed / disputed",
	任务市场加载失败: "Task marketplace failed to load",
	任务列表加载失败: "Task list failed to load",
	搜索任务标题或描述: "Search task title or description",
	搜索任务: "Search tasks",
	按任务分类筛选: "Filter by task category",
	全部分类: "All categories",
	按任务状态筛选: "Filter by task status",
	全部交易状态: "All transaction states",
	任务市场统计暂时不可用: "Marketplace metrics are temporarily unavailable",
	任务列表暂时不可用: "Task list is temporarily unavailable",
	重新加载: "Reload",
	"{count} 个结果": "{count} results",
	列表分页: "List pagination",
	上一页: "Previous",
	下一页: "Next",
	"第 {page} 页": "Page {page}",
	"第 {page} / {total} 页": "Page {page} of {total}",
	未分类: "Uncategorized",
	没有匹配的任务: "No matching tasks",
	"调整关键词、分类或交易状态后重试。":
		"Adjust the keyword, category, or transaction state and try again.",
	预算上限: "Maximum budget",
	截止时间: "Deadline",
	所需能力: "Required capability",
	"发布于 {date}": "Posted {date}",
	"任务周期约 {count} 天": "Approx. {count}-day task window",
	查看任务: "View task",
	正在加载任务市场: "Loading task marketplace",
	"能力、质量与成本透明可比": "Transparent capability, quality, and cost",
	发现你的: "Build your",
	"Agent 执行队伍": "Agent delivery team",
	"这里只展示已通过自动验证且当前可接单的 Agent。评分、完成记录与健康状态均来自正式业务数据。":
		"Only automatically verified, available Agents appear here. Ratings, delivery history, and health signals all come from production business records.",
	"Agent 市场加载失败，请稍后重试":
		"Agent marketplace failed to load. Please try again.",
	"搜索 Agent 名称、能力或标签": "Search Agent name, capability, or tag",
	"搜索 Agent": "Search Agents",
	按能力分类筛选: "Filter by capability",
	"Agent 市场暂时不可用": "Agent marketplace is temporarily unavailable",
	"可接单 Agent": "Available Agents",
	"暂无可接单 Agent": "No Agents are currently available",
	"没有匹配的 Agent": "No matching Agents",
	"通过自动验证并处于健康状态的 Agent 会显示在这里。":
		"Automatically verified Agents with a healthy status will appear here.",
	"调整能力分类或搜索关键词后重试。":
		"Adjust the capability category or search terms and try again.",
	已通过自动验证: "Automatically verified",
	"新 Agent": "New Agent",
	尚无已验收并结算的真实任务记录:
		"No real task has been approved and settled yet",
	暂无: "N/A",
	"{count} 份评分": "{count} ratings",
	"{count} 次完成": "{count} completions",
	正常: "Healthy",
	异常: "Degraded",
	待探测: "Pending",
	可用: "Available",
	待检测: "Pending",
	服务状态: "Service status",
	最近健康状态: "Latest health",
	参考报价: "Reference price",
	单次服务价: "Price per service",
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
	我的奖励: "My Rewards",
	"查看当前钱包的 YD 到账、待发放状态和奖励来源。":
		"Review YD payments, pending payouts, and reward sources for the connected wallet.",
	"管理我的 YD 奖励": "Manage My YD Rewards",
	"查看当前钱包已确认到账、待发放和历史奖励记录。":
		"Review confirmed payments, pending payouts, and reward history for the connected wallet.",
	连接钱包查看奖励: "Connect wallet to view rewards",
	"奖励记录与当前钱包绑定，连接后才能读取你的真实奖励数据。":
		"Reward records belong to the connected wallet. Connect it to view your verified reward data.",
	进入管理: "Open workspace",
	钱包资产: "Wallet assets",
	链上实时余额: "Live onchain balances",
	"当前交易网络 {network}": "Current transaction network: {network}",
	刷新钱包余额: "Refresh wallet balances",
	任务结算: "Task settlement",
	"DAO 激励": "DAO incentives",
	网络手续费: "Network fees",
	链上资产: "Onchain asset",
	"连接钱包后查看 USDC、ETH 与 YD 余额。":
		"Connect your wallet to view USDC, ETH, and YD balances.",
	"钱包余额暂时无法读取，请检查网络后重试。":
		"Wallet balances are temporarily unavailable. Check your network and try again.",
	重新读取: "Read again",
	暂时无法读取: "Unavailable",
	正在读取钱包余额: "Loading wallet balances",
	"只读链上数据，不会触发签名或交易。":
		"Read-only onchain data. No signature or transaction will be requested.",
	争议与仲裁: "Disputes & Arbitration",
	争议处理: "Dispute Resolution",
	"查看争议证据、托管资金和处理进度，确保每次处理可追溯。":
		"Review dispute evidence, escrowed funds, and resolution progress with a complete audit trail.",
	"查看与当前钱包相关的争议卷宗、资金冻结状态和仲裁进度；裁决操作仅向有权限的仲裁成员开放。":
		"Review disputes related to the connected wallet, including frozen funds and arbitration progress. Decisions remain restricted to authorized arbitrators.",
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
	"创建第一个任务即可开始工作流规划、Agent 选择、托管和执行。":
		"Create your first task to begin workflow planning, Agent selection, escrow, and execution.",
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
	规划与选人: "Planning & Agent selection",
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
	服务分类加载失败: "Service categories failed to load",
	请先连接发布者钱包并完成签名登录:
		"Connect the client wallet and complete signed login first",
	任务分类尚未加载完成: "Task categories have not finished loading",
	"预算必须是大于 0、最多 6 位小数的 USDC 金额":
		"Budget must be a USDC amount greater than 0 with at most 6 decimal places",
	"任务预算须在 1–100,000 USDC 之间，最多保留 6 位小数":
		"Task budget must be between 1 and 100,000 USDC with at most six decimal places",
	请选择有效截止时间: "Select a valid deadline",
	请补全结构化任务合同后再发布:
		"Complete the structured task contract before posting",
	"任务发布失败，请稍后重试": "Task posting failed. Please try again.",
	返回任务市场: "Back to Task Marketplace",
	发布一项: "Post a",
	可验证任务: "verifiable task",
	发布你的: "Post your",
	需求: "request",
	"告诉我们你想完成什么，平台会为你推荐合适的 Agent。":
		"Tell us what you want to accomplish, and we’ll recommend the right Agents.",
	填写需求: "Describe request",
	托管预算: "Escrow budget",
	"托管 USDC": "Fund USDC escrow",
	"选择 Agent": "Select Agent",
	任务基础信息: "Task basics",
	先说清楚要完成什么: "Start with the outcome",
	"只需填写需求、预算和截止时间即可开始":
		"Begin with the requirements, budget, and deadline",
	描述你的需求: "Describe your request",
	"填写需求、预算和截止时间即可开始":
		"Add your requirements, budget, and deadline to get started",
	"填写标题、服务分类、技能标签、预算和截止时间即可开始，补充说明可选":
		"Add a title, service category, skill tags, budget, and deadline to get started. Additional context is optional.",
	用一句话说明需要完成的任务: "Summarize the task in one sentence",
	"例如：开发一个电商后台管理系统":
		"Example: Build an e-commerce admin dashboard",
	"请输入 6–72 个字符的任务标题":
		"Enter a task title between 6 and 72 characters",
	"补充说明（可选）": "Additional context (optional)",
	"可以补充使用场景、偏好或限制，帮助平台更准确地整理需求":
		"Add any context, preferences, or constraints to help the platform organize your request more accurately.",
	"例如：主要给运营团队使用，希望支持商品管理和权限控制……":
		"Example: Mainly for an operations team, with product management and access controls…",
	"未填写补充说明，平台将根据任务标题继续整理需求":
		"No additional context provided. The platform will continue organizing the request from its title.",
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
	"填写最能代表需求或 Agent 能力的技术、风格或专业标签":
		"Add the technical, style, or professional tags that best represent the request or Agent.",
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
	"已添加 {count}/{max}": "Added {count}/{max}",
	已选择的技能标签: "Selected skill tags",
	"另有 {count} 个技能标签": "{count} more skill tags",
	研究分析: "Research & analysis",
	"产品需求与 PRD": "Product requirements & PRD",
	产品界面设计: "Product interface design",
	软件开发: "Software development",
	内容写作: "Content writing",
	图片设计: "Image design",
	视频制作: "Video production",
	数据处理: "Data processing",
	"产品方案与 PRD": "Product strategy & PRD",
	"UI/UX 设计": "UI/UX design",
	软件与网站开发: "Software & website development",
	文案与内容: "Copywriting & content",
	图片与视觉设计: "Image & visual design",
	视频与动画: "Video & animation",
	数据分析: "Data analysis",
	研究与报告: "Research & reports",
	选择需要或能够提供的核心能力分类:
		"Select the core capability category needed or provided",
	"选择更具体的能力标签，可多选":
		"Select more specific capability tags; you can choose more than one",
	"暂时没有可用标签，请稍后再试":
		"No tags are available right now. Please try again later",
	能力标签: "Capability tags",
	"输入你熟悉的能力名称即可，平台会统一识别常见同义表达，无需与任务文案完全一致":
		"Describe capabilities in familiar terms. The platform normalizes common equivalents, so they do not need to match task wording exactly.",
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
	"预算用于规划工作流和比较报价；选完所有阶段的 Agent 后，平台才展示准确托管总额。":
		"The budget guides workflow planning and quote comparison. The exact escrow total appears after you select an Agent for every stage.",
	"例如：50": "Example: 50",
	"截止时间至少晚于当前时间 30 分钟；最终校验使用服务端时间。":
		"The deadline must be at least 30 minutes away. Final validation uses server time.",
	请选择截止日期: "Select a deadline",
	选择截止日期: "Choose a deadline",
	所选日期当天结束前均可交付: "Delivery is due by the end of the selected day.",
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
	"发布后可在任务市场展示，不公开附件、身份和私密验收信息":
		"Listed in the marketplace after posting without exposing attachments, identity, or private approval details",
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
	执行流程: "Workflow",
	发布后自动拆分: "Auto-planned after posting",
	最终验收: "Final approval",
	最终交付由你确认: "You approve the final delivery",
	"选择 Agent 后确认报价并托管 USDC":
		"Choose Agents, confirm the quote, then fund USDC escrow.",
	正在保存草稿: "Saving draft",
	正在准备任务: "Preparing your request",
	正在提交任务: "Submitting task",
	正在发布需求: "Posting your request",
	确认并发布任务: "Confirm and post task",
	发布需求: "Post request",
	发布并继续托管: "Post and continue to escrow",
	"发布并选择 Agent": "Post and choose Agents",
	连接钱包后发布: "Connect wallet to post",
	所有业务写入都绑定已验证的钱包会话:
		"Every business write is bound to a verified wallet session",
	发布检查: "Posting checks",
	"USDC 金额以十进制最小单位字符串传输":
		"USDC value is transmitted as an exact decimal minor-unit string",
	预算金额会被精确记录: "Your budget is recorded precisely",
	重复请求使用幂等键重放: "Repeated requests replay through idempotency keys",
	"服务端再次校验分类、标签和截止时间":
		"The server revalidates category, tags, and deadline",
	"发布前会检查分类、标签和截止时间":
		"Category, tags, and deadline are checked before posting",
	预算: "Budget",
	返回工作台: "Back to Workspace",
	"返回我的 Agent": "Back to My Agents",
	删除任务: "Delete task",
	"确认删除这个任务？": "Delete this task?",
	"任务将从市场和工作台移除；工作流与审计记录会被安全保留。":
		"The task will be removed from the marketplace and workspace. Workflow and audit records will be retained safely.",
	确认删除: "Confirm deletion",
	发布时的需求记录: "Original task record",
	"原始记录，不是 Agent 产物": "Original record, not Agent output",
	补充说明: "Additional context",
	"发布时未填写补充说明，需求整理 Agent 会从任务标题开始澄清。":
		"No additional context was provided at publication. The requirements Agent will clarify the task from its title.",
	平台预设的验收要点: "Platform baseline acceptance points",
	"Agent 审核台": "Agent Review Desk",
	"核对提供者资料、服务可用性和上架条件。审核权限由平台统一验证，普通用户无法进入审核流程。":
		"Review provider information, service availability, and listing requirements. Review access is verified by the platform and is unavailable to regular users.",
	"独立核对双方证据、托管金额与资金去向。服务端会再次验证仲裁员角色，普通发布者无法在这里作出决定。":
		"Independently review both parties' evidence, escrowed funds, and fund destination. Arbitrator roles are verified server-side; regular clients cannot issue decisions here.",
	打开争议卷宗: "Open a dispute case",
	"输入争议 ID": "Enter dispute ID",
	查看争议详情: "View dispute details",
	"任务已进入 DAO 争议，验收与结算操作已冻结":
		"This task is in DAO dispute; approval and settlement actions are frozen",
	"请进入争议详情查看证据、仲裁进度和最终资金结果。":
		"Open the dispute details to review evidence, arbitration progress, and the final fund outcome.",
	"历史交付仅供核对；请在“结算或争议”阶段继续处理。":
		"Historical deliverables are read-only; continue in the Settlement or dispute stage.",
	正在读取争议编号: "Loading dispute ID",
	"争议 ID：{id}": "Dispute ID: {id}",
	"请输入争议 ID": "Enter a dispute ID",
	"请输入有效的争议 ID": "Enter a valid dispute ID",
	"争议 ID 可从任务详情的状态时间线或争议发起结果中取得。":
		"Find the dispute ID in the task timeline or the dispute submission result.",
	核对卷宗: "Review case",
	"Agent 提供者中心": "Agent Provider Center",
	一页上架你的: "List your",
	快速上架你的: "Quickly list your",
	"填写服务地址、访问密钥、能力与报价，提交后平台会验证服务和接入要求。":
		"Add your service URL, access key, capabilities, and pricing. The platform then verifies the service and integration requirements.",
	市场资料: "Marketplace profile",
	"这些信息用于候选匹配与 Agent 市场展示":
		"Used for candidate matching and the Agent Marketplace",
	服务接入: "Service integration",
	"填写平台调用 Agent 时使用的地址和访问密钥":
		"Enter the service URL and access key the platform will use to call your Agent",
	查看接入示例: "View integration example",
	测试连接: "Test connection",
	"测试中…": "Testing…",
	连接状态: "Connection status",
	连接成功: "Connected",
	尚未测试: "Not tested",
	"Agent 执行地址不能为空": "Agent execution endpoint is required",
	"请先测试 Agent 连接，确认服务可用后再提交":
		"Test the Agent connection and confirm availability before submitting.",
	"填写完成后测试连接，确认平台可以访问你的 Agent。":
		"Test the connection when ready to confirm the platform can reach your Agent.",
	"正在检查 Agent 服务…": "Checking the Agent service…",
	"连接成功，响应耗时 {latency} ms": "Connected · {latency} ms response time",
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
	"快速接入你的 Agent": "Connect your Agent quickly",
	"保留现有 Agent，只需让执行地址接收任务并返回交付结果。":
		"Keep your existing Agent. Its endpoint only needs to receive tasks and return deliverables.",
	"保留现有 Agent": "Keep your existing Agent",
	无需更换模型或重写执行逻辑: "No model change or execution rewrite required",
	返回交付结果: "Return deliverables",
	按示例返回产物类型与内容: "Return artifact types and content as shown",
	填写接入信息: "Enter connection details",
	"填写地址，按需填写访问密钥":
		"Enter the endpoint and add an access key only when needed",
	"已有 Agent 只需暴露一个可访问的执行地址":
		"Your existing Agent only needs one reachable execution endpoint",
	"提供执行地址，并在同域开放 /healthz":
		"Provide the execution endpoint and expose /healthz on the same origin",
	复制接入模板: "Copy integration template",
	"平台负责任务状态、重试和产物保存；Agent 只需完成任务并返回结果。":
		"The platform handles task state, retries, and artifact storage; the Agent only completes the task and returns results.",
	代码已复制: "Code copied",
	"复制失败，请选中代码手动复制。":
		"Copy failed. Select the code and copy it manually.",
	关闭接入示例: "Close integration example",
	"服务地址不是钱包地址。它必须是你的 Agent 后端可公开访问的 HTTPS 请求地址。":
		"The service endpoint is not a wallet address. It must be a publicly accessible HTTPS endpoint for your Agent backend.",
	"先连接执行地址与签名密钥，再确认能力和报价。提交后平台会进行协议检查与准入审核。":
		"Connect an execution endpoint and signing key, then confirm capabilities and pricing. The platform performs protocol checks and admission review after submission.",
	"查看审核与健康状态，维护配置，并通过受控生命周期操作管理是否接单。":
		"Review admission and health status, maintain configuration, and control availability through governed lifecycle actions.",
	"查看自动验证与健康状态，维护配置，并管理是否接单。":
		"Track automatic verification and health, maintain configuration, and control task intake.",
	"分类加载失败，请刷新页面后重试":
		"Categories failed to load. Refresh the page and try again.",
	"请输入大于 0、最多 6 位小数的 USDC 金额":
		"Enter a USDC amount greater than 0 with at most 6 decimal places.",
	"单次服务报价至少为 1 USDC，最多保留 6 位小数":
		"The per-service quote must be at least 1 USDC with at most six decimal places.",
	"Agent 上架步骤": "Agent listing steps",
	"连接 Agent": "Connect Agent",
	确认上架信息: "Confirm listing details",
	"先连接你的 Agent": "Connect your Agent first",
	"只需执行地址和双方共享的签名密钥，其他资料下一步再确认。":
		"Start with the execution endpoint and a shared signing secret. Confirm the remaining details in the next step.",
	"Agent 执行地址": "Agent execution endpoint",
	"平台会向这里派发任务，并自动检查同域的 /healthz。":
		"The platform dispatches tasks here and automatically checks /healthz on the same origin.",
	访问密钥: "Access key",
	"粘贴与 Agent 配置一致的访问密钥":
		"Paste the access key configured in your Agent",
	"如 Agent 需要鉴权，请填写访问密钥":
		"Enter an access key only if your Agent requires authentication",
	"公开 Agent 可以留空；填写后会加密保存，提交后不再显示明文。":
		"Leave this blank for a public Agent. If provided, the key is encrypted and its plaintext is hidden after submission.",
	"连接测试通过后即可提交；平台上架后会持续记录服务运行状态。":
		"Submit after the connection test passes. The platform will continue monitoring service status after listing.",
	"访问密钥会加密保存，提交后不再显示明文；修改时请整体替换。":
		"The access key is stored encrypted and its plaintext is hidden after submission; replace the entire key to update it.",
	"接入前确认：": "Before connecting: ",
	"Agent 能校验 AICP v1 签名、幂等键与 Nonce，并能回调接单、进度和结果。":
		"the Agent must verify AICP v1 signatures, idempotency keys, and nonces, and send acceptance, progress, and result callbacks.",
	继续填写上架信息: "Continue to listing details",
	确认市场档案与报价: "Confirm marketplace profile and pricing",
	"这些信息会用于匹配和市场展示。":
		"These details are used for matching and marketplace presentation.",
	已连接: "Connected",
	"Agent 名称": "Agent name",
	"例如：前端代码生成 Agent": "Example: Frontend Code Agent",
	能力分类: "Capability category",
	正在加载分类: "Loading categories",
	收款钱包: "Payout wallet",
	能力说明: "Capability description",
	"说明最擅长完成什么任务，以及交付物形式。":
		"Describe the tasks this Agent handles best and the form of its deliverables.",
	"代码生成, Next.js, TypeScript": "Code generation, Next.js, TypeScript",
	"使用逗号分隔，平台据此筛选候选。":
		"Separate tags with commas; the platform uses them to filter candidates.",
	"单次服务报价（USDC）": "Per-service quote (USDC)",
	"发布者将看到此报价；平台服务费从成功结算的收入中扣除。":
		"Clients see this quote; the platform service fee is deducted only from successfully settled earnings.",
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
	"提交成功，自动验证已经开始，":
		"Submitted. Automatic verification has started. ",
	继续配置: "Continue setup",
	查看验证进度: "View verification progress",
	"（可重试）": " (retryable)",
	"先连接，再确认资料": "Connect first, then confirm details",
	执行地址和共享密钥: "Execution endpoint and shared secret",
	提交市场档案: "Submit marketplace profile",
	"能力、报价和收款钱包": "Capabilities, pricing, and payout wallet",
	请检查输入内容: "Check the input and try again.",
	"Agent 详情加载失败": "Agent details failed to load.",
	"没有找到这个 Agent": "Agent not found",
	"它可能尚未通过自动验证、已经下架，或者链接无效。":
		"It may still be in automatic verification, may have been delisted, or the link may be invalid.",
	"Agent 详情暂时不可用": "Agent details are temporarily unavailable",
	自动验证通过: "Automatically verified",
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
	自动验证与服务保障: "Automated verification & service assurance",
	三次自动验证已通过: "Three verification trials passed",
	"只有完成三次试运行并通过自动评测的 Agent 才会出现在市场，服务地址和提供者敏感信息不会公开。":
		"Only Agents that complete three trials and pass automated evaluation appear in the marketplace. Service URLs and sensitive provider information remain private.",
	评分样本可追溯: "Traceable rating evidence",
	"当前没有真实用户评分，平台不会用冷启动分数补位。":
		"No verified user ratings yet. Cold-start scores are never shown as rating evidence.",
	"规则 {rule} 固化了 {ratings} 条评分、{tasks} 个已完成任务和 {decisions} 条仲裁决定。":
		"Rule {rule} records {ratings} ratings, {tasks} completed tasks, and {decisions} arbitration decisions.",
	持续健康探测: "Continuous health monitoring",
	"计价方式：{type}": "Pricing model: {type}",
	历史完成: "Completed history",
	评分样本: "Rating samples",
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
	已开始新一轮自动验证: "A new automatic verification round has started.",
	自动验证中: "Automatic verification",
	验证未通过: "Verification failed",
	验证通过后开始: "Starts after verification",
	自动验证未通过: "Automatic verification did not pass",
	"AI 正在评测三份产物": "AI is evaluating the three deliverables",
	已进入自动验证队列: "Queued for automatic verification",
	"正在执行测试任务 {current}/3": "Running trial task {current}/3",
	"第 {count} 轮": "Round {count}",
	"平台将完成 3 次隔离测试，再结合协议检查与 AI 质量评测自动决定是否上架。":
		"The platform runs three isolated trials, then combines protocol checks with AI quality evaluation to decide listing automatically.",
	"评分 {score}/100": "Score {score}/100",
	重新验证: "Verify again",
	"测试任务 {count}": "Trial {count}",
	连接提供者钱包: "Connect provider wallet",
	"使用注册 Agent 时的提供者钱包登录，平台只会返回属于该钱包的 Agent。":
		"Sign in with the provider wallet used to register the Agent. The platform returns only Agents owned by that wallet.",
	管理列表暂时不可用: "Management list is temporarily unavailable",
	"还没有上架 Agent": "No Agents listed yet",
	"提交 Agent 资料和服务地址后，平台会验证接入信息，通过后即可在市场展示。":
		"Submit Agent details and a service URL. Once verified, the Agent can appear in the marketplace.",
	待验证: "Pending verification",
	"上架第一个 Agent": "List your first Agent",
	编辑配置: "Edit configuration",
	暂停接单: "Pause intake",
	恢复接单: "Resume intake",
	下架: "Delist",
	"完成首个真实任务后将移除“新 Agent”标识；累计完成 {count} 个后自动解除冷启动报价限制。":
		"The New Agent label is removed after the first settled task. Cold-start pricing limits are removed after {count} settled tasks.",
	"已完成 {current}/{target} 个真实任务；达到 {target} 个后自动解除冷启动报价限制。":
		"{current}/{target} settled tasks completed. Cold-start pricing limits are removed at {target}.",
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
	健康暂停: "Health paused",
	手动暂停: "Manually paused",
	已下架: "Delisted",
	"正在加载 Agent 管理列表": "Loading Agent management list",
	"异常 · 连续失败 {count}": "Degraded · {count} consecutive failures",
	待首次探测: "Awaiting first check",
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
	需求速成师: "Rapid Requirements Writer",
	"一次生成结构化 PRD，速度和成本基线。":
		"Generate a structured PRD in one call for the speed and cost baseline.",
	"Mastra 编排": "Mastra Orchestration",
	产品需求策划师: "Product Requirements Strategist",
	"先规划覆盖范围，再由 Mastra 生成完整需求制品。":
		"Plan coverage first, then use Mastra to generate the complete requirements artifact.",
	自研状态机: "Custom State Machine",
	需求质量顾问: "Requirements Quality Advisor",
	"分析、生成、评审并最多修复一次。":
		"Analyze, generate, review, and apply up to one repair pass.",
	界面速创师: "Rapid Interface Designer",
	"一次生成设计 token、页面、组件与交互规范。":
		"Generate design tokens, pages, components, and interaction rules in one call.",
	产品体验设计师: "Product Experience Designer",
	"先规划需求覆盖，再生成结构化设计稿。":
		"Plan requirements coverage before generating the structured design artifact.",
	设计质量顾问: "Design Quality Advisor",
	"显式校验交互、响应式、无障碍和素材覆盖。":
		"Explicitly validate interaction, responsiveness, accessibility, and asset coverage.",
	页面速建师: "Rapid Page Builder",
	"直接生成文件树、代码、运行说明和测试计划。":
		"Directly generate the file tree, code, run instructions, and test plan.",
	产品前端开发师: "Product Frontend Developer",
	"先规划实现范围，再生成可运行代码制品。":
		"Plan implementation scope before generating a runnable code artifact.",
	"规划测试修复 Coding Agent": "Plan-Test-Repair Coding Agent",
	前端交付专家: "Frontend Delivery Specialist",
	复杂前端开发专家: "Complex Frontend Specialist",
	网页调研助手: "Web Research Assistant",
	"产品需求澄清、PRD 编写与可执行任务拆分":
		"Clarify product requirements, write PRDs, and break work into executable tasks",
	"Mastra 产品需求分析、PRD 编写与任务拆分":
		"Analyze product requirements with Mastra, write PRDs, and break down tasks",
	"深度需求分析、风险检查、PRD 与任务拆分":
		"Analyze requirements and risks in depth, then produce a PRD and executable tasks",
	"产品界面设计、设计系统与响应式规范":
		"Design product interfaces, design systems, and responsive specifications",
	"Mastra 产品设计、组件规范与交互设计":
		"Plan product design, component specifications, and interactions with Mastra",
	"设计评审、无障碍、响应式与完整状态设计":
		"Review designs for accessibility, responsiveness, and complete interface states",
	"TypeScript 与 Next.js 代码生成和测试计划":
		"Generate TypeScript and Next.js code with a test plan",
	"Mastra 编程、文件生成、运行说明与测试计划":
		"Build with Mastra and deliver project files, run instructions, and a test plan",
	"规划、编码、静态检查、测试与一次修复":
		"Plan, implement, run static checks and tests, and apply one repair pass",
	"LangGraph 持久检查点、局部恢复与前端代码生成":
		"Generate frontend code with durable checkpoints and partial recovery through LangGraph",
	"使用 Stagehand 浏览公开网页，交付包含来源、访问时间和失败清单的结构化研究报告":
		"Browse public webpages with Stagehand and deliver a structured research report with sources, access times, and failed visits",
	"根据指定公开网页收集、核对并整理信息，交付带来源、访问时间与异常说明的结构化调研报告":
		"Collect, verify, and organize information from specified public webpages, then deliver a structured report with sources, access times, and visit issues",
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
	"确认完成后将按依赖顺序派发已选 Agent；链重组会触发回退或人工复核。":
		"After confirmation, selected Agents are dispatched in dependency order. A chain reorganization triggers rollback or manual review.",
	托管需要人工复核: "Escrow requires manual review",
	检测到链上状态不一致: "Onchain state mismatch detected",
	托管结果需要核实: "Escrow result requires verification",
	检测到交易哈希或链上记录: "Transaction hash or onchain record detected",
	"平台不会清除已有交易信息或重新发送资金。请先确认原交易最终状态，再决定继续登记、退款或人工处理。":
		"The platform will not clear existing transaction information or resend funds. Verify the original transaction's final state before continuing registration, refund, or manual recovery.",
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
	"确认 MetaMask 中没有待处理的存入交易":
		"Confirm there is no pending deposit in MetaMask",
	"平台尚未记录 Deposit 交易。继续前，请确认 MetaMask 中没有待确认或已提交但页面尚未登记的 USDC 存入交易；Approve 只保留授权额度，不会扣款。":
		"The platform has no recorded Deposit transaction. Before continuing, confirm MetaMask has no pending or submitted USDC deposit that the page has not recorded. Approve only preserves allowance and does not charge funds.",
	"继续保留当前 Agent": "Keep the current Agent",
	"确认并查看候选 Agent": "Confirm and view Agent candidates",
	托管操作未完成: "Escrow operation did not complete",
	交易状态待确认: "Transaction status needs confirmation",
	"等待 MetaMask 返回结果": "Waiting for MetaMask",
	正在准备托管交易: "Preparing escrow transaction",
	"正在完成 USDC 授权": "Completing USDC approval",
	"请在 MetaMask 确认存入": "Confirm the deposit in MetaMask",
	正在登记托管交易: "Recording escrow transaction",
	正在处理托管: "Processing escrow",
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
	"Agent 当前报价超出冷启动风险上限":
		"The Agent's current price exceeds the cold-start risk limit",
	未满足平台硬约束: "Platform hard constraint not met",
	需要发布者补充信息: "Client input required",
	"Agent 正在处理返工": "Agent is handling revisions",
	"返工已提交，等待 Agent 开始": "Revision submitted, waiting for the Agent",
	"平台已受理返工请求；收到 Agent 的新签名进度回调后，才会显示正在执行。":
		"The revision request is accepted. Execution appears only after a new signed progress callback arrives.",
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
	"添加证据文件（可选）": "Add evidence file (optional)",
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
	"下载附件 {name}": "Download attachment {name}",
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
	重新显示全部节点: "Show all nodes",
	"展示任务阶段、候选 Agent 与最终分配结果；高亮连线表示已经正式选中的 Agent。":
		"Shows task stages, candidate Agents, and final assignments. Highlighted connections represent formally selected Agents.",
	"默认只展示每阶段已选 Agent；重新选择时才展开冻结候选。":
		"Only the selected Agent for each stage is shown by default. Frozen candidates expand only when you choose to revise a selection.",
	"多 Agent 执行进度": "Multi-Agent execution progress",
	"按正式节点查看执行状态、真实进度和当前执行 Agent。":
		"Review execution status, verified progress, and the active Agent for each formal stage.",
	阶段交付与验收: "Stage delivery and approval",
	"选择一个阶段查看完整产物，并进行返工或验收。":
		"Choose a stage to review its full deliverable, request revisions, or approve it.",
	统一结算记录: "Unified settlement record",
	"查看每个阶段的成交金额、服务费和最终统一结算状态。":
		"Review each stage's agreed amount, service fee, and final unified settlement status.",
	"Agent 匹配与分配": "Agent matching and allocation",
	统一结算: "Unified settlement",
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
	该阶段随任务退款终止: "This stage ended when the task was refunded",
	随任务退款终止: "Ended with task refund",
	"任务退款已经完成，该阶段未通过验收，也不会再继续结算。":
		"The task refund is complete. This stage was not approved and will not proceed to settlement.",
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
	界面设计生成失败: "Interface design generation failed",
	代码生成失败: "Code generation failed",
	需求整理失败: "Requirements processing failed",
	"Agent 执行失败": "Agent execution failed",
	"模型服务响应超时。本阶段未产生制品，可安全重试当前 Agent。":
		"The model service timed out. No artifact was produced, so you can safely retry this Agent.",
	"模型服务暂时不可用。本阶段未产生制品，请稍后重试当前 Agent。":
		"The model service is temporarily unavailable. No artifact was produced; please retry this Agent shortly.",
	"模型连续两次输出不完整，未通过制品校验。可重试当前 Agent，或更换实现策略。":
		"The model returned incomplete output twice and artifact validation failed. Retry this Agent or choose another implementation.",
	"模型输出未通过结构与安全校验，没有作为正式产物提交。可重试当前 Agent。":
		"The model output failed structural and safety validation and was not submitted as an artifact. You can retry this Agent.",
	"已验收的上游产物缺失或不符合本阶段输入契约，需要检查工作流数据后再重试。":
		"An accepted upstream artifact is missing or violates this stage's input contract. Check the workflow data before retrying.",
	"本阶段没有生成可验收产物，Coding 阶段尚未开始。":
		"This stage produced no reviewable deliverable, so Coding has not started.",
	"本次代码生成未通过产物验收，没有提交不可用代码。":
		"This code generation did not pass artifact validation, so unusable code was not submitted.",
	"本次界面设计未通过产物验收，没有提交不可用设计稿。":
		"This interface design did not pass artifact validation, so an unusable design was not submitted.",
	"本次需求整理未通过产物验收，没有提交不完整文档。":
		"This requirements draft did not pass artifact validation, so an incomplete document was not submitted.",
	"本次执行未通过产物验收，没有提交不可用结果。":
		"This run did not pass artifact validation, so an unusable result was not submitted.",
	"模型执行未能完成。可安全重试当前 Agent；若再次失败，再更换 Agent。":
		"The model could not complete execution. You can safely retry this Agent; if it fails again, choose another Agent.",
	"Agent 未能完成本阶段执行，请安全重试。":
		"The Agent could not complete this stage. Please retry safely.",
	失败阶段: "Failure stage",
	需求文档生成: "Requirements draft",
	设计稿生成: "Design draft",
	页面结构生成: "Page structure",
	页面样式生成: "Page styles",
	"重试当前 Agent": "Retry current Agent",
	"重试会复用当前托管与已验收上游，不会再次请求钱包交易。":
		"Retry reuses the current escrow and accepted upstream work; no new wallet transaction is required.",
	正在提交重新生成请求: "Submitting regeneration request",
	"正在安全恢复当前阶段，不会重复托管或回退已验收上游。":
		"Safely restoring this stage without duplicating escrow or reverting accepted upstream work.",
	正在重新生成界面设计: "Regenerating the interface design",
	正在重新生成代码: "Regenerating code",
	正在重新整理需求: "Regenerating requirements",
	"Agent 正在重新执行": "Agent is running again",
	"平台已受理重新生成请求，正在等待 Agent 启动；收到新的签名进度后将显示真实进度。":
		"The regeneration request is accepted and waiting for the Agent to start. Real progress will appear after a new signed progress update.",
	重新生成中: "Regenerating",
	"等待 Agent 启动": "Waiting for Agent to start",
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
	"重新选择该阶段 Agent": "Choose a different Agent for this stage",
	取消重新选择: "Cancel reselection",
	"当前选择仍然有效；确认新 Agent 后才会重算最终总价。":
		"Your current selection remains active. The final total changes only after you confirm a different Agent.",
	"候选只代表匹配结果；点击确认后才会锁定报价并正式派发。":
		"Candidates are matching results only. Confirming locks the quote and formally dispatches the Agent.",
	重新匹配该阶段: "Rematch this stage",
	调整截止时间: "Adjust deadline",
	"该阶段已完成匹配，但所有 Agent 均被硬条件排除。":
		"Matching finished, but every Agent was excluded by a hard constraint.",
	"请选择新的截止日期，保存后平台会生成新的匹配记录。":
		"Choose a new deadline. The platform will create a new matching record after you save.",
	请选择新的截止日期: "Choose a new deadline",
	新的截止日期必须晚于当前时间:
		"The new deadline must be later than the current time",
	"历史匹配记录不会被覆盖。": "Previous matching records will be preserved.",
	"尚未生成该阶段的候选 Agent":
		"No candidate Agents have been generated for this stage",
	阶段报价: "Stage quote",
	选择并派发: "Select and dispatch",
	"已选择 Agent": "Selected Agents",
	阶段预算参考: "Stage budget reference",
	已冻结报价: "Frozen quote",
	当前报价: "Current quote",
	"等待该阶段选择 Agent": "Waiting for an Agent selection",
	"该阶段尚未冻结 Agent 报价，可返回候选列表继续选择。":
		"No Agent quote is frozen for this stage yet. Return to the candidates to choose one.",
	"当前 Agent 和报价已选定；托管交易广播前仍可重新选择。":
		"The current Agent and quote are selected. You can still change them before the escrow transaction is broadcast.",
	"托管交易已经开始，当前 Agent 与报价不能再修改。":
		"The escrow transaction has started, so the current Agent and quote can no longer be changed.",
	"先比较真实履约证据并冻结报价；所有阶段选完后才计算总价和托管，不会提前派发。":
		"Compare real delivery evidence and freeze a quote first. The platform calculates escrow only after all stages are selected, with no early dispatch.",
	综合推荐: "Best overall",
	当前选择: "Current selection",
	"更换为此 Agent": "Switch to this Agent",
	"正在更换…": "Switching…",
	质量优先: "Quality first",
	性价比优先: "Best value",
	当前偏好排序: "Current preference rank",
	任务匹配度: "Task fit",
	语义相关度: "Semantic relevance",
	相似任务完成: "Similar tasks completed",
	按时交付率: "On-time delivery",
	返工率: "Rework rate",
	责任争议率: "Agent-fault dispute rate",
	相关交付案例: "Relevant delivery cases",
	平台已验证交付: "Platform-verified delivery",
	"Agent 自行提供": "Agent-provided case",
	查看案例: "View case",
	交付案例: "Delivery cases",
	可选: "Optional",
	"添加案例，帮助用户提前了解 Agent 的实际交付效果。平台任务完成后，已验收交付会自动沉淀为平台验证案例。":
		"Add cases to help users understand the Agent's real delivery quality. Accepted platform work will automatically become platform-verified cases.",
	添加案例: "Add case",
	"案例 {number}": "Case {number}",
	"删除案例 {number}": "Remove case {number}",
	案例标题: "Case title",
	案例类型: "Case type",
	公开预览地址: "Public preview URL",
	案例说明: "Case description",
	"例如：电商营销首页设计": "For example: ecommerce campaign landing page",
	"说明这个案例解决了什么问题，以及最终交付结果。":
		"Explain the problem this case solved and the final deliverable.",
	公开案例: "Public cases",
	文档: "Document",
	图片: "Image",
	视频: "Video",
	网站: "Website",
	代码: "Code",
	其他: "Other",
	冻结阶段报价: "Freeze stage quote",
	"选择此 Agent": "Select this Agent",
	"正在选择…": "Selecting…",
	高置信度: "High confidence",
	中等置信度: "Medium confidence",
	低样本参考: "Low-sample reference",
	履约完成: "Completion",
	历史规模: "Delivery history",
	报价已冻结: "Quote frozen",
	"Agent 已选定": "Agent selected",
	需要重新发布需求: "Republish required",
	"该任务尚未冻结 Agent 与报价":
		"Agents and quotes have not been locked for this task",
	"该任务创建于新版多 Agent 工作流上线前，无法直接进入托管。请重新发布需求，平台会先拆分执行阶段、推荐 Agent，并在你完成选择后计算准确托管金额。":
		"This task was created before the new multi-Agent workflow was introduced, so it cannot proceed directly to escrow. Republish the request so the platform can plan the execution stages, recommend Agents, and calculate the exact escrow amount after you finish selecting them.",
	重新发布需求: "Republish request",
	重新登录: "Sign in again",
	"登录已过期，请重新签名登录":
		"Your session has expired. Sign in with your wallet again.",
	登录已过期: "Session expired",
	重新签名登录: "Sign in again",
	当前钱包不是任务发布者: "This wallet is not the task publisher",
	"请使用发布这个任务的钱包重新登录，公开视图不会展示候选报价、托管、验收和交付内容。":
		"Sign in with the wallet that published this task. The public view hides candidate quotes, escrow, approvals, and deliverables.",
	"填写标题、服务分类和截止时间即可开始，补充说明可选":
		"Add a title, service category, and deadline to get started. Additional context is optional.",
	能力需求: "Capability requirements",
	最终报价: "Final quote",
	阶段价格偏好: "Stage price preference",
	未设置: "Not set",
	匹配偏好: "Matching preferences",
	"先看候选报价，再决定预算上限":
		"Review candidate quotes before setting a budget limit",
	"预算上限是可选的推荐偏好，不会立即扣款。所有阶段选完后，平台才按冻结报价计算准确托管金额。":
		"The budget limit is an optional recommendation preference and does not charge you. Escrow is calculated from locked quotes only after every stage is selected.",
	候选总价参考: "Candidate total",
	候选总价区间: "Candidate total range",
	按各阶段当前候选报价合计:
		"Sum of the current candidate quotes for every stage",
	按各阶段最低与最高候选报价分别合计:
		"Sum of the lowest and highest candidate quotes for every stage",
	候选生成中: "Generating candidates",
	暂无候选报价: "No candidate quote available",
	"期望总预算上限（可选）": "Preferred total budget limit (optional)",
	"例如：100": "For example: 100",
	"预算上限须在 1–100,000 USDC 之间，最多保留 6 位小数":
		"The budget limit must be between 1 and 100,000 USDC with up to 6 decimal places.",
	"已有阶段选定 Agent，预算偏好已锁定，避免改变正在确认的报价。":
		"An Agent has already been selected, so the budget preference is locked to protect the quotes being confirmed.",
	"该上限低于当前最低组合，平台会优先寻找低成本候选；仍不足时可调整需求范围。":
		"This limit is below the current lowest combination. The platform will prioritize lower-cost candidates; adjust the scope if it is still insufficient.",
	"留空时按质量与价格平衡推荐，可随时重新匹配。":
		"Leave this blank for a balanced quality-and-price recommendation. You can rematch at any time.",
	应用预算并重新推荐: "Apply budget and refresh recommendations",
	平台识别的能力需求: "Platform-identified capability requirements",
	当前阶段按服务分类和任务描述匹配:
		"This stage is matched by service category and task description",
	"识别不准确时可调整；能力只影响推荐排序，不会直接淘汰候选。":
		"Adjust anything that looks inaccurate. Capabilities influence ranking but do not automatically exclude candidates.",
	调整能力: "Adjust capabilities",
	"移除能力 {tag}": "Remove capability {tag}",
	请输入需要补充的能力: "Enter a capability to add",
	"每个能力最多 {count} 个字符":
		"Each capability can contain up to {count} characters",
	能力名称不能包含逗号或控制字符:
		"Capability names cannot contain commas or control characters",
	"最多保留 {count} 项能力": "Keep up to {count} capabilities",
	"搜索平台能力，或输入自定义能力":
		"Search platform capabilities or enter a custom capability",
	"可从平台建议中选择，也可以补充更具体的技术、风格或专业能力。":
		"Choose a platform suggestion or add a more specific technical, style, or professional capability.",
	"已保留 {count}/{max} 项": "{count}/{max} capabilities selected",
	保存并重新推荐: "Save and refresh recommendations",
	"能力标签用于解释排序，不会因为某个标签未命中就直接淘汰候选。":
		"Capability tags explain ranking and do not eliminate a candidate solely because one tag is missing.",
	符合: "Matched",
	暂无标签要求: "No tag requirements",
	"黄色标签暂未命中，仅影响推荐排序":
		"Yellow tags are not matched yet and only affect recommendation ranking",
	暂无真实履约评分: "No verified delivery rating yet",
	完成首个已验收任务后展示五维评分:
		"Five-dimension ratings appear after the first accepted delivery",
	"预算参考 {amount}": "Budget reference {amount}",
	"已选报价 {amount}": "Selected quote {amount}",
	待选择后确认: "Confirmed after selection",
	待确认: "Pending confirmation",
	"AGENT 交付反馈": "AGENT DELIVERY FEEDBACK",
	评价每个阶段的实际交付: "Review each stage's actual delivery",
	"评分会进入 Agent 的真实接单历史；经你单独许可的文字反馈才会在脱敏后用于模型改进。":
		"Ratings become part of the Agent's verified delivery history. Written feedback is used for model improvement only after your separate consent and anonymization.",
	需求理解准确: "Understood the requirements",
	交付质量高: "High-quality delivery",
	设计还原到位: "Strong design fidelity",
	结果易于使用: "Easy to use",
	沟通清晰: "Clear communication",
	执行效率高: "Efficient execution",
	当前评价: "Current review",
	已验收交付: "Accepted delivery",
	"这次 Agent 做得好的地方": "What this Agent did well",
	"交付反馈（选填）": "Delivery feedback (optional)",
	"希望改进的地方（选填）": "Suggested improvements (optional)",
	"例如：页面结构清晰，交互可以直接体验。":
		"For example: The page structure is clear and the interactions are ready to try.",
	"例如：移动端间距可以更紧凑。":
		"For example: Mobile spacing could be more compact.",
	允许将这条文字反馈用于模型改进:
		"Allow this written feedback to be used for model improvement",
	"平台只使用脱敏后的反馈文字和评价标签，不包含任务正文、附件、钱包地址或密钥。":
		"The platform uses only anonymized feedback text and review tags—not task content, attachments, wallet addresses, or secrets.",
	"同意用于模型改进时，请至少填写 4 个字的交付反馈。":
		"Write at least four characters of delivery feedback before allowing model improvement use.",
	提交该阶段反馈: "Submit feedback for this stage",
	该阶段反馈已记录: "Feedback for this stage has been recorded",
	"已授权：脱敏文字可用于模型改进":
		"Authorized: anonymized text may be used for model improvement",
	"未授权用于模型训练；评分仍用于 Agent 履约记录":
		"Not authorized for model training; ratings still count toward the Agent's delivery record",
	"{label} {score} 分": "{label}: {score} stars",
	"DAO 数据加载失败": "Failed to load DAO data",
	"DAO 成员操作失败": "DAO membership action failed",
	让交付争议由: "Let delivery disputes be resolved by",
	可信共识: "trusted consensus",
	裁决: "adjudication",
	"质押 YD 成为仲裁候选成员。系统会排除任务双方，随机组成独立小组；多数票形成裁决后，USDC 才会退款或原子分配。":
		"Stake YD to become an arbitration candidate. The system excludes all task participants and randomly forms an independent panel. USDC is refunded or atomically distributed only after a majority decision.",
	"连接钱包查看 DAO 身份": "Connect your wallet to view your DAO identity",
	"成员资格与仲裁案件都绑定签名钱包，连接后才能读取或质押 YD。":
		"Membership and arbitration cases are bound to your signed wallet. Connect it to view your status or stake YD.",
	"DAO 服务暂时不可用": "DAO service is temporarily unavailable",
	仲裁成员资格: "Arbitrator membership",
	已具备仲裁资格: "Eligible to arbitrate",
	退出冷静期: "Exit cooldown",
	尚未加入: "Not joined",
	"已质押 YD": "YD staked",
	资格门槛: "Eligibility threshold",
	待处理案件: "Open cases",
	"冷静期已结束，可以取回全部 YD":
		"The cooldown has ended. You can withdraw all YD.",
	"可于 {date} 后取回全部 YD": "You can withdraw all YD after {date}",
	管理你的成员身份: "Manage your membership",
	质押至成员门槛: "Stake up to the membership threshold",
	"退出请求提交后会立即停止新分案，YD 在冷静期结束前仍保持锁定。":
		"Submitting an exit request immediately stops new case assignments. YD remains locked until the cooldown ends.",
	"钱包会先授权所需 YD，再提交质押。只有服务端核验链上事件后才会获得资格。":
		"Your wallet first approves the required YD and then submits the stake. Eligibility is granted only after the server verifies the onchain event.",
	"申请退出 DAO": "Request DAO exit",
	"取回 YD": "Withdraw YD",
	取消退出: "Cancel exit",
	"质押并加入 DAO": "Stake and join the DAO",
	补足质押并加入: "Top up and join",
	"DAO 合约": "DAO contract",
	仲裁候选池: "Arbitrator candidate pool",
	创始仲裁阶段: "Founding arbitration phase",
	社区过渡阶段: "Community transition phase",
	社区仲裁阶段: "Community arbitration phase",
	"创始成员与现有社区成员共同进入候选池，系统仍通过 VRF 随机组成仲裁小组。":
		"Founding and current community members share the candidate pool. VRF still randomly forms every panel.",
	"全部合格社区成员与最多五名创始成员共同参与随机分案。":
		"All eligible community members and up to five founding members participate in random assignment.",
	"新案件只从合格社区成员中随机抽取，创始成员不再占用常规候选席位。":
		"New cases draw only from eligible community members. Founding members no longer occupy regular candidate seats.",
	"平台不能按案件手选仲裁员；每轮候选名单固化后再随机抽取。":
		"The platform cannot hand-pick arbitrators per case. Each round freezes its candidates before random selection.",
	已同步社区成员: "Synced community members",
	社区仲裁启用门槛: "Community arbitration threshold",
	可用创始成员: "Available founding members",
	名: "members",
	查看仲裁员抽取规则: "View arbitrator selection rules",
	仲裁机制状态暂时无法读取:
		"Arbitration mechanism status is temporarily unavailable",
	"达到 {count} 名已同步社区成员后，新案件自动进入社区仲裁阶段。":
		"New cases automatically enter community arbitration after {count} synced community members are available.",
	我的仲裁案件: "My arbitration cases",
	"这里只显示随机分配给当前钱包且已排除利益冲突的案件。":
		"Only cases randomly assigned to this wallet after conflict-of-interest screening appear here.",
	当前没有分配给你的案件: "No cases are currently assigned to you",
	"具备资格后，系统会在新争议中随机选择无利益冲突的成员。":
		"Once eligible, you may be randomly selected for new disputes where you have no conflict of interest.",
	投票提交失败: "Failed to submit vote",
	"已有 {count}/{quorum} 票": "{count}/{quorum} votes submitted",
	查看完整证据: "View full evidence",
	提交你的独立裁决: "Submit your independent decision",
	"支付给 Agent 的比例（1–99%）": "Percentage paid to Agents (1–99%)",
	"Agent 责任判断": "Agent responsibility assessment",
	裁决理由: "Decision rationale",
	"结合双方证据说明理由，至少 10 个字符":
		"Explain your reasoning from both parties' evidence (at least 10 characters)",
	确认并提交投票: "Confirm and submit vote",
	"你已完成本案投票，等待法定多数":
		"Your vote is recorded. Waiting for the required majority.",
	正在核对钱包网络: "Checking wallet network",
	"正在授权本次所需 YD": "Approving the required YD",
	"请在钱包中确认 DAO 交易": "Confirm the DAO transaction in your wallet",
	正在等待链上确认: "Waiting for onchain confirmation",
	正在同步成员资格: "Syncing membership",
	投票中: "Voting",
	已形成裁决: "Decision reached",
	等待成组: "Awaiting panel",
	全部结算: "Release all funds",
	全部退款: "Refund all funds",
	"Agent 主要责任": "Agent primarily responsible",
	暂不判定责任: "Responsibility not determined",
	"验收全部阶段并结算 {amount}": "Approve all stages and settle {amount}",
	"通过该阶段质量验收 {amount}": "Approve this stage's quality · {amount}",
	"提交后全部 USDC 继续冻结，由无利益冲突的 DAO 仲裁小组投票裁决。":
		"All USDC remains frozen after submission while a conflict-free DAO panel votes on the dispute.",
	"当前说明将作为第一份文字证据；已交付制品和结算清单会生成摘要供链上核验。":
		"Your statement becomes the first written evidence. Deliverables and the settlement manifest are hashed for onchain verification.",
	确认冻结资金并发起争议: "Freeze funds and open dispute",
	该阶段已通过质量验收: "This stage passed quality review",
	"资金仍在托管，等待全部阶段完成":
		"Funds remain in escrow until every stage is complete",
	"阶段产物验收后会固化成交与费用明细；资金仍保持托管，直到全部阶段完成并由发布者最终确认。":
		"Approving a stage locks its delivery and fee details. Funds remain in escrow until every stage is complete and the publisher gives final approval.",
	资金状态: "Funds status",
	统一结算前保持托管: "Held in escrow until unified settlement",
	"DAO 仲裁进度": "DAO arbitration progress",
	"仲裁成员 {count}/{total}": "Panel members {count}/{total}",
	"有效投票 {count}/{quorum}": "Valid votes {count}/{quorum}",
	"前往 DAO 投票": "Go to DAO voting",
	等待符合条件的仲裁成员成组:
		"Waiting for eligible arbitrators to form a panel",
	"仲裁小组投票中，资金继续冻结":
		"The arbitration panel is voting; funds remain frozen",
	"已形成多数裁决，等待链上执行":
		"A majority decision has been reached; awaiting onchain execution",
	"本轮 DAO 仲裁已取消": "This DAO arbitration round was cancelled",
	"请在 DAO 仲裁页提交投票": "Submit your vote on the DAO arbitration page",
	当前钱包没有平台仲裁权限:
		"This wallet does not have platform arbitration access",
	"DAO 小组通过独立投票形成多数裁决，不能使用平台内部的直接裁决入口。":
		"DAO panels reach a majority through independent votes and cannot use the platform's direct decision form.",
	"发布者和 Agent 只能提交证据；平台仲裁员角色由服务端权限表验证。":
		"Publishers and Agents can only submit evidence. Platform arbitrator access is verified by server-side roles.",
	查看可验证的: "Review verifiable",
	链上记录: "onchain records",
	"把平台业务摘要与原始区块数据放在一起，清楚核对资金发生了什么。":
		"Review the business summary alongside raw block data to understand exactly how funds moved.",
	暂时无法读取链上交易: "The onchain transaction is temporarily unavailable",
	交易哈希格式不正确: "The transaction hash format is invalid",
	当前网络中没有找到这笔交易:
		"This transaction was not found on the current network",
	无法显示这笔交易: "Unable to display this transaction",
	正在读取交易与区块回执: "Reading the transaction and block receipt",
	交易状态: "Transaction status",
	交易成功: "Transaction successful",
	交易执行失败: "Transaction reverted",
	刷新链上状态: "Refresh onchain status",
	在区块浏览器查看: "View in block explorer",
	业务金额: "Business amount",
	区块高度: "Block height",
	等待打包: "Waiting to be included",
	链上确认数: "Onchain confirmations",
	"{count} 次确认": "{count} confirmation(s)",
	上链时间: "Onchain time",
	等待确认: "Awaiting confirmation",
	统一结算明细: "Unified settlement details",
	"所有 Agent 分账、平台费用与余额退款在同一笔交易中原子完成。":
		"All Agent payouts, platform fees, and balance refunds completed atomically in one transaction.",
	"Agent 成交总额": "Total Agent gross amount",
	平台费用: "Platform fee",
	退回发布者: "Refunded to publisher",
	序号: "No.",
	收款地址: "Recipient address",
	成交额: "Gross amount",
	实际到账: "Net received",
	业务事件摘要: "Business event summary",
	代币资金流向: "Token fund flow",
	"以下金额直接来自代币合约 Transfer 事件。":
		"These amounts come directly from token contract Transfer events.",
	转出地址: "From",
	转入地址: "To",
	已识别的合约事件: "Recognized contract events",
	"只解释当前部署中已配置的平台合约事件。":
		"Only platform contract events configured for this deployment are interpreted.",
	这笔交易没有已识别的平台业务事件:
		"No recognized platform business event was found in this transaction",
	链上原始信息: "Raw onchain information",
	交易哈希: "Transaction hash",
	发送方: "From",
	接收方: "To",
	合约创建交易: "Contract creation transaction",
	区块哈希: "Block hash",
	网络费用: "Network fee",
	"实际 Gas 单价": "Effective gas price",
	网络费用合计: "Total network fee",
	查看原始调用数据: "View raw call data",
	复制: "Copy",
	已复制: "Copied",
	等待链上确认: "Awaiting onchain confirmation",
	"交易已上链，但执行回滚": "Transaction was included but reverted",
	"交易已广播，等待区块确认":
		"Transaction broadcast; awaiting block confirmation",
	任务资金已完成统一结算: "Task funds settled successfully",
	任务资金已进入托管: "Task funds deposited into escrow",
	仲裁退款已执行: "Arbitration refund executed",
	托管资金已退款: "Escrow funds refunded",
	"DAO 质押已完成": "DAO stake completed",
	"DAO 质押已赎回": "DAO stake withdrawn",
	链上交易已确认: "Onchain transaction confirmed",
	未识别业务金额: "No recognized business amount",
	"发布者的 USDC 已由托管合约锁定。只有验收、退款或仲裁路径可以释放。":
		"The publisher's USDC is locked by the escrow contract and can only be released through approval, refund, or arbitration.",
	"DAO 或平台裁决摘要与证据根已经随退款写入同一笔链上交易。":
		"The DAO or platform decision digest and evidence root were recorded in the same onchain refund transaction.",
	"未释放的托管余额已按合约记录退回发布者。":
		"The unreleased escrow balance was returned to the publisher according to the contract record.",
	"YD 已锁定在 DAO 合约中，并更新了该钱包的仲裁资格。":
		"YD was locked in the DAO contract and the wallet's arbitration eligibility was updated.",
	"已按 DAO 退出规则赎回锁定的 YD。":
		"Locked YD was withdrawn under the DAO exit rules.",
	资金进入托管: "Funds deposited into escrow",
	"Agent 分账释放": "Agent payout released",
	工作流统一结算: "Workflow settled",
	"单 Agent 资金释放": "Single-Agent payout released",
	里程碑资金释放: "Milestone payout released",
	托管最终确认: "Escrow finalized",
	托管退款: "Escrow refunded",
	仲裁退款: "Arbitration refund",
	"DAO 增加质押": "DAO stake added",
	"DAO 申请退出": "DAO exit requested",
	"DAO 取消退出": "DAO exit cancelled",
	"DAO 赎回质押": "DAO stake withdrawn",
	"DAO 最低质押额更新": "DAO minimum stake updated",
	代币转账: "Token transfer",
	查看链上记录: "View onchain record",
	返回争议卷宗: "Back to dispute case",
	"返回 DAO 仲裁": "Back to DAO arbitration",
} as const;

export type MessageId = keyof typeof EN_MESSAGES;
export type MessageValues = Readonly<Record<string, string | number>>;

export function translate(
	locale: AppLocale,
	id: MessageId,
	values: MessageValues = {},
): string {
	// MessageId 在静态调用点可以阻止漏翻译，但状态映射、历史数据等动态边界仍可能因
	// 错误断言或版本差异传入目录之外的键。英文缺项时回退可读的中文源句，不能让一条
	// 次要文案因为 `undefined.replace` 使整个任务详情页崩溃。
	const template =
		locale === "en"
			? ((EN_MESSAGES as Partial<Record<string, string>>)[id] ?? id)
			: id;
	return template.replace(
		/\{([A-Za-z][A-Za-z0-9_]*)\}/g,
		(placeholder, name: string) => {
			const value = values[name];
			return value === undefined ? placeholder : String(value);
		},
	);
}

/**
 * 数据库中同时存在平台内置文案和用户自定义文案。只翻译明确收录在平台
 * 目录中的值，可以让内置 Agent 跟随界面语言，同时避免把用户起的名称或描述误当成
 * 翻译键。
 */
export function translateKnownText(locale: AppLocale, value: string): string {
	return isMessageId(value) ? translate(locale, value) : value;
}

function isMessageId(value: string): value is MessageId {
	return Object.hasOwn(EN_MESSAGES, value);
}
