# Stitch 设计稿生成操作手册

> 适用项目：AI Agent 协作协议平台  
> 使用方式：严格按本文顺序操作。每完成一步，先检查并选定结果，再进入下一步。提示词可直接复制到 Stitch。  
> 界面语言：简体中文；设计描述使用英文，以提高布局和视觉控制的稳定性。

## 1. 最终目标

使用 Stitch 产出一套风格一致、可进入 Figma 深化并能被前端拆分实现的 MVP 设计稿，覆盖以下核心流程：

```text
公开任务市场
  → 发布任务
  → Agent 匹配与选择
  → 任务执行追踪
  → 结果比较与验收
  → 结算或争议
```

辅助角色页面包括：

- 我的任务工作台。
- Agent 提供者工作台。
- Agent 注册与配置。
- 运营仲裁工作台。

不要在第一轮设计以下后续能力：

- Agent 竞价/抢单。
- 代币空投。
- 资金质押和固定收益。
- V2 模型配置后台。
- 完全自动化的多 Agent 工作流编辑器。

## 2. 推荐视觉方向与金融配色

### 2.1 推荐方向：Trusted Intelligence

本项目涉及钱包、资金托管、结算和争议，应优先表达“可信、稳定、透明”，再表达“AI 和未来感”。推荐使用浅色金融产品风格，辅以克制的 AI 紫色。

视觉关键词：

```text
Trustworthy fintech interface
Professional AI operations platform
Clean and data-rich
High contrast
Calm and transparent
Subtle AI visual language
Minimal decorative gradients
```

不推荐：

- 大面积紫色、粉色或彩虹渐变。
- 霓虹发光、赛博朋克和 Crypto Casino 风格。
- 过度透明的 Glassmorphism。
- 纯黑背景配高饱和绿色。
- 用金币、火箭和价格 K 线装饰普通任务页面。
- 只依赖红、黄、绿表达交易状态。

### 2.2 推荐色板

| 用途 | 颜色 | 使用建议 |
| --- | --- | --- |
| 页面背景 | `#F6F8FB` | 大面积背景，降低视觉疲劳 |
| 卡片/面板 | `#FFFFFF` | 主要内容容器 |
| 主文字 | `#172033` | 标题、金额和关键数据 |
| 次要文字 | `#667085` | 描述、时间和辅助信息 |
| 边框 | `#DCE3EC` | 表单、表格和卡片边界 |
| 品牌深蓝 | `#173B67` | 导航、可信品牌表达 |
| 主操作蓝 | `#2563EB` | 主按钮、链接和选中状态 |
| AI 紫色 | `#6D5DFB` | Agent 匹配、AI 建议、网络连线；控制用量 |
| 托管青绿 | `#0F766E` | Escrow、资金已保护和已确认 |
| 成功 | `#16865C` | 验收、完成和到账成功 |
| 警告 | `#B7791F` | 待确认、即将超时和需要处理 |
| 危险 | `#C2414B` | 失败、争议和不可逆风险 |
| 信息浅蓝 | `#EAF2FF` | 普通说明背景 |
| AI 浅紫 | `#F0EEFF` | AI 建议背景，不用于资金状态 |

使用原则：

- 蓝色代表主操作和可信赖。
- 青绿色代表托管保护和资金确认。
- 紫色只代表 AI、Agent 和智能推荐，不代表支付成功。
- 红色只用于错误、风险和争议，不用于普通取消按钮。
- 金额、状态和按钮必须满足 WCAG AA 对比度。
- 状态同时使用文字和图标，不能只靠颜色区分。

### 2.3 字体、间距与组件

- 中文字体：`Noto Sans SC` 或系统无衬线字体。
- 英文与数字：`Inter`。
- 采用 8px 间距系统。
- 页面最大内容宽度建议 1280px。
- 卡片圆角 12px，表单控件圆角 8px。
- 阴影克制，主要依赖边框与背景层级。
- 金额和任务状态使用稳定、易扫描的排版，不使用装饰字体。
- 默认桌面画布 1440px，同时准备 390px 移动端关键页面。

## 3. 操作前准备

### 3.1 创建项目

在 Stitch 中创建一个新项目，项目名称建议：

```text
AI Agent Collaboration Platform - MVP
```

### 3.2 使用参考图

将现有参考图按以下方式使用：

- `4.首页.png`：只参考任务卡片需要展示哪些信息，不复制渐变和页面布局。
- `5.发布任务页.png`：只参考字段范围，不复制自动验收文案、竞价开关和视觉风格。
- `1.标签-分类模型.png`、`2.小结.png`、`3.评分维度.png`：作为业务说明，不作为视觉参考。

如果 Stitch 支持图片附件，第一步可以上传首页和发布任务页，并在提示词中明确：

```text
Use the attached screens only as information-architecture references.
Do not copy their gradients, low-contrast styling, mixed-language copy, or visual identity.
```

### 3.3 固定操作规则

每次生成新页面时：

1. 使用同一个 Stitch 项目。
2. 附上已经确认的上一张页面或设计系统截图。
3. 明确要求复用颜色、字体、导航、按钮、卡片和状态标签。
4. 每次只生成一个页面或一个紧密连续的流程。
5. 不满意时要求局部修改，不要立即重新生成整页。
6. 页面确认后再进入下一页。

## 4. 第一步：生成视觉方向

将下面提示词完整复制到 Stitch：

```text
Create three distinct high-fidelity visual directions for a desktop AI Agent task collaboration platform.

Product context:
The platform connects task publishers with third-party AI Agents. Users publish tasks, escrow funds, review matched Agents, track execution, compare up to three results, approve payment, or open a dispute.

Primary brand attributes:
- trustworthy
- intelligent
- professional
- transparent
- calm
- technically advanced but easy to use

Create these three directions:
A. Trusted Intelligence: professional fintech foundation with restrained AI accents
B. Premium AI Marketplace: polished marketplace with stronger Agent discovery visuals
C. Protocol Operations: data-rich operational interface for advanced users

Recommended color logic:
- deep navy and blue for trust and primary actions
- teal for escrow protection and confirmed financial states
- restrained violet only for AI and Agent recommendations
- neutral light gray background with white surfaces
- semantic green, amber and red only for system status

Avoid:
- crypto casino aesthetics
- excessive neon colors
- large decorative gradients
- low-contrast glassmorphism
- generic chatbot layouts
- cryptocurrency price charts on unrelated pages
- mixed Chinese and English UI copy

Show for each direction:
- top navigation and side navigation
- typography hierarchy
- color palette
- buttons and form controls
- task card
- Agent card
- wallet connection state
- escrow status component
- task status badges
- table and activity timeline

Viewport: 1440px desktop.
All visible UI copy must be in Simplified Chinese.
Keep only established technical terms such as Agent, API and USDT in English.
Do not translate Agent as “代理”.
```

生成后操作：

- 默认选择 A：Trusted Intelligence。
- 如果 A 的紫色或渐变仍然过多，要求减少，而不是切换整体方向。
- 检查文字与背景对比度、金额可读性和状态区分。

## 5. 第二步：冻结设计系统

将选中的 A 方向截图作为附件，然后复制：

```text
Use the attached Trusted Intelligence direction as the authoritative visual reference.

Create a production-ready design system page for the AI Agent collaboration platform.

Do not redesign the visual identity. Refine and document it.

Include:
- brand colors with semantic usage
- typography scale for Simplified Chinese and Latin text
- 8px spacing system
- responsive grid and content width
- primary, secondary, tertiary, destructive and loading buttons
- text input, textarea, select, date picker, tag input and file upload
- checkbox, radio, switch and segmented control
- task status badges
- Agent health and trial badges
- escrow, payment pending, payment confirmed, refund and dispute status components
- task cards and Agent cards
- table, tabs, pagination and filters
- toast, alert, modal, drawer and confirmation dialog
- skeleton, empty, error and offline states
- network graph node styles for Agent matching

Required status labels:
草稿、待托管、待匹配、待接单、执行中、待验收、返工中、争议中、退款中、已退款、已完成、已超时。

Use these color semantics:
- blue: primary action
- teal: escrow protection and confirmed funds
- violet: AI and Agent recommendation only
- green: successful completion
- amber: pending or attention required
- red: error, dispute or irreversible risk

Accessibility requirements:
- WCAG AA text contrast
- never rely on color alone
- clear keyboard focus states
- minimum 44px touch targets for interactive controls

All visible UI copy must be in Simplified Chinese.
```

确认后，将设计系统页面作为后续所有页面的视觉参考。

## 6. 第三步：应用框架与公开任务市场

```text
Design a high-fidelity desktop public task marketplace for an AI Agent collaboration platform.

Use the attached approved design system as the authoritative reference. Reuse exactly the same colors, typography, spacing, navigation, buttons, cards, badges and form controls. Do not introduce a new visual language.

Viewport: 1440px desktop.
Language: Simplified Chinese.

Page purpose:
Allow visitors and signed-in users to discover public tasks without mixing public marketplace statistics with the signed-in user's private task statistics.

Application shell:
- product logo and name
- navigation: 任务市场、Agent 市场、工作台、开发者文档
- wallet connection button
- notification center
- user menu

Marketplace content:
- clear page title and short explanation
- search by task title, description or tag
- category filter
- status filter
- budget range filter
- deadline filter
- sort by relevance, newest, budget and deadline
- category shortcuts
- task result count
- list/grid view switch

Each public task card must show:
- task title
- short description
- category and normalized tags
- fixed price or budget range with one currency label
- deadline
- required capability level
- public visibility badge
- escrow protection status
- assignment mode: 用户确认 or 自动分配
- current task status
- publisher address in shortened form

Do not show private attachments, full publisher identity, internal matching scores or personal dashboard metrics.

Include:
- normal state with realistic Chinese content
- empty search state
- wallet not connected state
- clear primary action: 发布任务

Visual style:
professional fintech foundation, calm AI accents, high information clarity, minimal gradients.
```

检查重点：公开信息和私密信息是否明确；金额、截止时间和托管状态是否容易扫描。

## 7. 第四步：我的任务工作台

```text
Design a high-fidelity desktop “我的任务” workspace for the task publisher.

Use the attached approved marketplace screen and design system as authoritative references. Keep the same application shell and component system.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Page purpose:
Help a signed-in publisher quickly identify tasks that require action. Do not mix these private statistics with the public marketplace.

Include:
- summary cards: 全部任务、待处理、执行中、待验收、争议中
- an attention panel for tasks requiring user action
- tabs for all task states
- search and filters
- task table with title, selected Agent, amount, current state, latest update, deadline and next action
- recent transaction activity
- clear “发布任务” primary action

Prioritize actionable states:
- 待托管
- 待选择 Agent
- 待验收
- 即将超时
- 需要补充信息
- 争议处理中

For each task, show one clear next action rather than many equal-weight buttons.

Include realistic states:
- normal workspace
- no tasks yet
- one task requiring urgent acceptance
- one on-chain transaction waiting for confirmation

Use concise production-ready Chinese copy. Do not add token prices, investment returns or speculative Web3 widgets.
```

## 8. 第五步：发布任务

```text
Design a high-fidelity desktop multi-step “发布任务” flow for an AI Agent collaboration platform.

Use the attached approved design system and application shell. Do not change the visual language.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Use a five-step structure:
1. 任务要求
2. 预算与时间
3. 分配方式
4. 可见性
5. 确认与托管

Step 1 — 任务要求:
- 任务标题
- controlled category selector
- normalized tag input with suggestions and duplicate merging
- 详细描述
- 可量化验收标准
- 交付物与输出格式
- attachment upload with privacy notice

Step 2 — 预算与时间:
- pricing type: 固定价格 or 预算区间
- show only one relevant amount control based on pricing type
- currency selector shown once
- deadline
- required capability level
- estimated service level

Step 3 — 分配方式:
- 用户确认, selected by default
- 自动分配, optional
- explain ranking, price limit and failure fallback
- do not include bidding because bidding is not part of MVP

Step 4 — 可见性:
- 私密任务, selected by default
- 公开任务
- provide a preview of exactly which fields become public

Step 5 — 确认与托管:
- complete task summary
- estimated payment and platform fee
- escrow protection explanation
- cancellation and refund summary
- manual acceptance, selected by default
- machine acceptance only when a versioned validator is configured
- wallet and network status
- primary action: 确认并托管资金

Include:
- step indicator
- save draft
- previous and next actions
- inline validation errors
- unsaved changes warning
- transaction pending state
- transaction failed state with a safe retry action

Do not claim that all AI outputs can be automatically verified.
Do not release funds immediately when an Agent reports completion.
Do not use DAO arbitration copy because the arbitration model is not confirmed.
```

## 9. 第六步：Agent 匹配与选择

```text
Design a high-fidelity desktop “选择 Agent” page for an AI Agent collaboration platform.

Use the attached approved design system and task publishing flow as authoritative references.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Page purpose:
Help the publisher understand why each Agent was recommended, compare candidates and select one with confidence.

Layout:
- compact task summary panel
- restrained Agent matching network visualization
- accessible comparison list or table
- sticky selection summary and confirmation action

The network visualization should place the task at the center and matched Agents around it. Use violet only for AI matching relationships. Highlight the selected Agent with a check mark and stronger connection. The visualization must not replace the detailed list.

Each Agent must show:
- Agent name and category
- matched normalized tags
- short, understandable matching explanation
- quoted price
- estimated completion time
- availability and health status
- recent completion rate
- quality score with sample size
- confirmed responsibility dispute rate
- completed task count
- trial/new Agent badge when applicable

Support:
- compare up to three Agents
- manually select one Agent
- optional automatic assignment explanation
- change sorting between recommended, quality, price and delivery time
- view detailed Agent profile in a drawer

Include these states:
- recommended candidates available
- no matching Agent
- selected Agent became unavailable
- all candidates exceed budget
- matching is still in progress

Do not expose internal model weights, private Agent credentials or raw technical feature vectors.
Do not make the graph decorative or visually dominant over decision information.

Primary action: 确认 Agent 并派发任务。
```

## 10. 第七步：任务执行详情

```text
Design a high-fidelity desktop task execution detail page for an AI Agent collaboration platform.

Use the attached approved design system and Agent matching screen. Keep all global components consistent.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Page purpose:
Give the publisher a trustworthy, auditable view of task execution without exposing raw internal reasoning or sensitive Agent data.

Include:
- task title, status and task ID
- selected Agent summary
- escrow amount and protection state
- deadline and estimated completion time
- overall progress
- event timeline with timestamps
- Agent progress updates
- requests for additional information
- task attachments and deliverable requirements
- transaction history with shortened transaction hash
- cancel, request support and open dispute actions according to current state

Timeline events:
- 资金托管已确认
- Agent 已接单
- Agent 开始执行
- 进度更新
- 需要补充信息
- 已提交结果

Include states:
- normal execution
- SSE connection interrupted with polling fallback message
- Agent response delayed
- task approaching deadline
- task timed out
- additional information requested

Use one clear next action for each state. Do not display private chain-of-thought. Show concise execution summaries and auditable events only.
```

## 11. 第八步：结果比较、验收与结算

```text
Design a high-fidelity desktop result review and acceptance page for an AI Agent task.

Use the attached approved design system and task detail page. Preserve the same navigation, spacing, cards, buttons and status system.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Page purpose:
Allow the publisher to compare one to three submitted results, select one, verify it against acceptance criteria and make a safe settlement decision.

Include:
- original task summary
- acceptance criteria checklist
- tabs or side-by-side comparison for up to three results
- result version, submission time, summary and files
- safe preview and download actions
- Agent notes
- publisher review notes
- selected result state

Actions:
- 验收并结算, primary but requires confirmation
- 要求返工
- 发起争议

Before settlement, show a confirmation panel with:
- selected result
- escrow amount
- platform fee
- amount paid to Agent
- irreversible action warning
- wallet/network state

Include states:
- three valid results
- only one result
- result file cannot be previewed
- acceptance period approaching deadline
- settlement transaction pending
- settlement failed with safe retry

Do not automatically approve a subjective AI result.
Do not show settlement as completed until the transaction is confirmed.
Use red only for dispute and irreversible risk, not for normal secondary actions.
```

## 12. 第九步：争议处理

```text
Design a high-fidelity desktop dispute submission and tracking flow for an AI Agent task platform.

Use the attached approved design system and result review page. Maintain exactly the same visual language.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Dispute submission must include:
- task and escrow summary
- selected dispute reason
- structured explanation
- evidence upload
- evidence deadline
- explanation that funds will remain frozen
- preview before final submission
- explicit confirmation

Dispute tracking must include:
- current dispute state
- funds frozen status
- both parties' evidence timeline
- deadlines
- operator messages
- final decision and reason
- settlement or refund transaction state

Include states:
- draft dispute
- evidence required
- waiting for the other party
- under review
- decision made but chain transaction pending
- dispute completed

Do not mention DAO arbitration because the arbitration model is not confirmed.
Do not imply that a decision has been executed before the on-chain transaction is confirmed.
Use calm, neutral language and avoid visually presuming either party is guilty.
```

## 13. 第十步：Agent 提供者工作台

```text
Design a high-fidelity desktop Agent provider workspace for an AI Agent collaboration platform.

Use the attached approved design system and application shell.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Include:
- Agent list with online, degraded, paused, trial and offline states
- pending task requests
- active tasks
- tasks requiring provider action
- recent delivery and earnings summary
- health and response-time trends
- task completion, quality, communication and confirmed dispute metrics
- sample size and recent/all-time distinction
- clear “注册 Agent” action

Each Agent row/card must show:
- name and category
- normalized capability tags
- pricing
- health status and last health check
- availability
- trial or approved state
- active task count
- recent quality score with sample size
- pause/resume action

Do not display speculative investment returns, token rewards or ranking guarantees.
Do not treat total earnings as the primary quality metric.
```

## 14. 第十一步：Agent 注册与配置

```text
Design a high-fidelity desktop Agent registration and configuration flow.

Use the attached approved design system and Agent provider workspace.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Use these sections:
1. 基本信息
2. 能力与定价
3. 接入配置
4. 连通性测试
5. 审核提交

Required fields and components:
- Agent name
- controlled category
- capability description
- normalized tags
- pricing type and price
- expected response time
- provider wallet address
- service endpoint
- authentication method
- secret input that can be replaced but never revealed after saving
- protocol version
- health-check result
- connection-test logs with sensitive values redacted
- review summary

Include:
- authentication failure
- protocol incompatibility
- connection timeout
- Agent internal error
- successful test
- secret replacement confirmation
- unsaved changes warning

Do not show saved secrets in plain text.
Do not put real API keys or credentials in example content.
```

## 15. 第十二步：运营仲裁工作台

```text
Design a high-fidelity desktop operations and arbitration workspace for authorized platform staff.

Use the attached approved design system, but optimize for dense operational data and auditability.

Language: Simplified Chinese.
Viewport: 1440px desktop.

Include:
- queue summary: Agent reviews, dispatch failures, timed-out tasks, transaction exceptions and disputes
- filters and saved views
- task, Agent, wallet and transaction search
- priority and SLA indicators
- dispute case table
- evidence review drawer
- task event timeline
- on-chain transaction status
- operator action history
- decision form with reason and evidence references
- full payment, partial payment and refund options shown as policy-dependent

Safety requirements:
- role and permission indicator
- second confirmation for high-risk actions
- mandatory reason field
- before/after state preview
- do not display an action as executed before chain confirmation
- immutable audit-log presentation

Do not make this page visually playful. Use a calm, dense and highly scannable operational layout.
```

## 16. 第十三步：移动端适配

核心桌面页面确认后，再复制：

```text
Create responsive mobile versions of the attached approved desktop screens for a 390px viewport.

Screens:
- public task marketplace
- publish task flow
- Agent matching and comparison
- task execution detail
- result review and settlement confirmation

Preserve the approved design system and semantic colors.

Mobile adaptation rules:
- do not shrink desktop tables into unreadable layouts
- convert tables into structured cards
- keep one primary action visible
- use bottom sheets for filters and detail comparison
- use a step-by-step form rather than a long single page
- replace the Agent network visualization with a compact optional preview and prioritize the comparison list
- keep wallet, escrow amount and transaction status readable
- minimum 44px touch targets
- avoid horizontal scrolling for primary content

All visible UI copy must be in Simplified Chinese.
```

## 17. 第十四步：补齐异常与空状态

```text
Create a comprehensive state matrix using the approved design system.

For each relevant component and page, design these states:
- loading and skeleton
- empty
- no search results
- validation error
- permission denied
- wallet not connected
- unsupported wallet network
- transaction pending
- transaction failed
- transaction confirmed
- Agent offline
- Agent became unavailable during selection
- no matching Agent
- dispatch retrying
- event stream disconnected with polling fallback
- task approaching deadline
- task timed out
- result file unavailable
- refund pending
- dispute in progress
- system maintenance

For every state, include:
- concise Simplified Chinese title
- one-sentence explanation
- one clear next action
- appropriate semantic icon and color

Never rely on color alone. Do not expose internal stack traces, queue names, private credentials or raw blockchain errors to end users.
```

## 18. 第十五步：全局一致性检查

把已经确认的核心页面作为附件，然后复制：

```text
Audit the attached screens as one product and produce corrected versions only where necessary.

Check and fix:
- navigation consistency
- typography hierarchy
- spacing and grid alignment
- button hierarchy
- border radius and shadow consistency
- status badge semantics
- wallet and escrow component consistency
- terminology consistency
- Chinese copy consistency
- accessibility contrast
- responsive behavior
- one clear primary action per state

Enforce these product rules:
- public marketplace and private workspace remain separate
- manual Agent selection is the default
- automatic assignment is explicitly enabled and explained
- bidding is not part of MVP
- subjective AI results require user acceptance
- machine acceptance requires a configured validator
- no financial operation appears complete before chain confirmation
- Agent scores show sample size
- dispute status remains neutral before a decision

Do not introduce a new design direction. Preserve the approved Trusted Intelligence visual system.

Return:
1. corrected key screens
2. a list of inconsistencies found
3. the final reusable component inventory
```

## 19. 局部修改提示词模板

当页面整体满意、只需调整局部时，使用下面模板，不要重新生成整页：

```text
Keep the current screen and visual system unchanged.

Modify only the following:
- [写明需要修改的区域]
- [写明目标]
- [写明必须保留的内容]

Do not change:
- navigation
- typography
- color palette
- spacing system
- card style
- unrelated content

All visible UI copy must remain in Simplified Chinese.
```

常用修改示例：

```text
Keep the current screen and visual system unchanged.

Modify only the Agent comparison section:
- increase the visual priority of matching reasons and delivery time
- show the quality score together with its sample size
- reduce the decorative prominence of the network graph
- make the selected Agent state more obvious with a check mark and highlighted connection

Do not change the navigation, task summary, color palette or page layout.
```

## 20. 每一页的验收清单

页面确认前逐项检查：

### 信息与业务

- 用户能否在 3 秒内判断当前状态和下一步动作？
- 金额、币种、截止时间和托管状态是否清楚？
- 是否错误展示了尚未实现的竞价、空投或质押？
- 自动分配是否为显式选项，而不是悄悄默认？
- 是否错误承诺 AI 结果能够自动验收？
- 链上未确认时是否仍显示“处理中”？
- 评分是否展示样本量？
- 公开页面是否泄露私密任务数据？

### 视觉与交互

- 是否只存在一个一级主按钮？
- 状态是否同时有文字、图标和颜色？
- 紫色是否只用于 AI/Agent 语义？
- 红色是否只用于错误、争议和高风险？
- 是否存在低对比度文字或透明卡片？
- 表单错误是否出现在对应字段附近？
- 空、加载、失败和不可用状态是否完整？
- 页面是否能拆成复用组件，而不是一张无法实现的海报？

### 跨页面一致性

- 导航、按钮、圆角和阴影是否一致？
- 同一个任务状态是否使用同一种标签？
- 钱包、托管和交易状态组件是否一致？
- 是否统一使用“Agent”，没有出现“代理人/智能代理”混用？
- 中文术语和标点是否一致？

## 21. 从 Stitch 到 Figma 和研发

1. 核心流程页面全部确认后，再导出或复制到 Figma。
2. 在 Figma 中把按钮、表单、标签、卡片、导航、状态和弹窗整理成组件及 Variants。
3. 使用 Auto Layout 重建关键容器，检查 Stitch 生成稿是否真正可响应。
4. 将色板、字体、间距、圆角和阴影整理成 Variables/Tokens。
5. 为每个页面补充默认、加载、空、错误、禁用和权限状态。
6. 将设计稿中的字段、状态和按钮与 PRD 的 `FR-*` 编号对应。
7. 研发评审重点检查：组件复用、接口数据、权限、状态机、链上确认和异常恢复。

Stitch 产物应视为视觉与交互初稿，不应直接替代 PRD、状态机、合约规则或安全评审。

## 22. 最短执行路径

如果时间有限，只执行以下步骤：

1. 生成并选择 Trusted Intelligence 视觉方向。
2. 冻结设计系统。
3. 生成发布任务页。
4. 生成 Agent 匹配页。
5. 生成任务执行详情页。
6. 生成结果验收与结算页。
7. 补齐异常状态。
8. 做全局一致性审查。
9. 导入 Figma 深化。

这四个核心页面能够最早验证产品是否真正清晰、可信且可落地。
