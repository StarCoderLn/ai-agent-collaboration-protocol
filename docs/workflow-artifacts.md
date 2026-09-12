# 正式多 Agent 工作流与制品契约

> 状态：v0.7 正式任务工作流权威契约
>
> 日期：2026-09-12
>
> 关联：`docs/prd.md` 2.1.1、feature 1、4、6、8～12

## 1. 目的与边界

本文档集中定义正式任务中跨 Agent 节点传递的制品知识，避免规划器、Agent、回调仓储
和前端分别解释同一份输入输出。任务、节点、分配、制品、验收与结算均以 PostgreSQL
持久化事实为准，前端只提供只读关系图和操作入口，不保存第二套工作流状态。

- 发布事务先创建正式执行图；每个节点完成选人并冻结准确总价后，任务才允许进入 USDC 托管。
- 每个可执行节点独立生成候选、锁定 assignment、接单、执行和提交制品，但中间验收不单独付款。
- 下游只能消费已经验收的完整上游制品，禁止只传摘要后重新解释需求。
- 中间节点的结构化制品通过版本化机器门禁后自动推进；最终节点必须由发布者验收。
- 所有节点完成且最终验收通过后，通过一次原子交易支付全部 Agent 和平台费用，并同时退还未成交余额。
- Mastra、DeepSeek SDK 或自研状态机的内部对象不得进入公共派发或制品契约。

React Flow 只展示服务端持久化的任务、节点、候选、最终分配和依赖边。节点不可拖动、
连线不可编辑，避免视觉操作被误认为已经改变正式任务顺序或资金分配。

## 2. 正式状态

工作流运行状态：

```text
planning | running | awaiting_review | completed | failed | disputed | cancelled
```

节点状态：

```text
blocked
  → matching
  → awaiting_agent_acceptance
  → executing
  → awaiting_review
  → accepted
```

节点还可进入 `execution_failed`、`rework`、`disputed` 或 `cancelled`。只有所有上游节点
都已 `accepted`，下游 `blocked` 节点才会进入 `matching`。运行聚合状态由节点事实计算，
调用方不得自行写入与节点相矛盾的状态。

## 3. 规划与候选 Agent

当前规划器使用确定性、可审计的模板生成基线工作流：

- 新软件任务：产品与界面设计 → Coding 开发实现，不默认加入付费 PRD。
- 新图片/视频任务：直接执行图片或视频生成；独立设计需求也只生成设计节点。
- 用户明确发布 PRD 服务需求时才创建独立需求节点；页面不新增购买开关。
- 研究、文档和通用任务：生成一个与分类相符的交付节点。

PRD、设计各有三种可比较实现，Coding 另有一个 LangGraph 持久恢复候选：

| 能力 | DeepSeek 直连 | Mastra 编排 | 自研状态机 | LangGraph |
| --- | --- | --- | --- | --- |
| PRD | `prd-direct` | `prd-mastra` | `prd-state-machine` | — |
| 设计 | `design-direct` | `design-mastra` | `design-state-machine` | — |
| Coding | `code-direct` | `code-mastra` | `code-state-machine` | `code-langgraph` |

候选使用同一 DeepSeek 模型。差异来自单次生成、多阶段 Mastra 编排，以及自研状态机或
LangGraph 的“TSX 验收 → CSS 消费已验收 TSX → 失败片段局部修复”。`code-langgraph`
另外通过 PostgreSQL checkpoint 支持跨连接恢复。平台一次节点只锁定并执行一个 Agent，
不会为了比较自动产生多份模型调用和结算成本。

## 4. 制品依赖

```text
原始任务合同 ──────────────┐
      │                   │
      ▼                   ▼
DesignArtifact ──────→ CodeArtifact
```

新设计节点声明 `TaskContract`，新 Coding 节点声明 `TaskContract+DesignArtifact`。
自建 Agent 将原始合同验证为内部 `task.requirements.v1` 输入，不调用 PRD 模型、不生成
虚假的用户故事或验收记录，也不把该输入当成交付制品。旧节点仍声明 `RequirementsArtifact`
或其组合并强制消费已验收 PRD，缺失或损坏不得降级；既有节点、报价与资金记录不迁移。

Coding 节点必须同时接收原始任务（旧任务为完整 PRD）和完整设计制品。每份交付制品包含 `schemaVersion`、`taskId`、
`generatedBy` 和 `generatedAt`；这些可信字段由代码补齐，不允许模型自行生成。派发层
同时传递上游节点 ID、结果 ID、输出契约、MIME 类型和完整内容或文件引用，以便 Agent
验证来源并保持链路可审计。

### 4.1 RequirementsArtifact

包含问题陈述、目标用户、目标/非目标、用户故事与验收标准、功能需求、约束、假设、
开放问题，以及带依赖和验收标准的可执行任务列表。

### 4.2 DesignArtifact

包含设计方向、设计 token、页面与区块、组件、交互状态、响应式和无障碍规则，以及
带真实示例内容的信息层级。`DesignArtifact v0.4` 还包含平台渲染器版本，以及由同一份
DesignSpec 确定性生成的 1440 桌面端和 390 移动端 SVG 设计稿。

图片是用户的主要验收产物，DesignSpec 是 Coding Agent 的机器输入。设计 Agent 不能提交
任意 HTML、TSX、CSS 或 SVG；平台渲染器只使用固定图元和转义文字，并在写入、读取和自动
验收边界重复拒绝脚本、事件处理器、外部引用、`foreignObject` 与错误画布尺寸。

### 4.3 CodeArtifact

包含实现摘要、文件树、代码文件、运行说明、测试计划和已知限制。Coding Agent 必须完整
继承 DesignSpec 的导航、Hero、指标、区块、真实文案和交互规则，并保留由 DesignSpec 推导
的稳定锚点。Coding Agent 会收到桌面与移动 SVG 设计稿的完整内容。Direct 与 Mastra 候选
可在同一响应中分段提交 `app/page.tsx` 与 `app/globals.css`；可靠状态机则先独立验收 TSX，
再把该份源码作为 CSS 步骤的权威输入，某段失败时只重做该段。两条路径复用相同的平台
文案、颜色 token、响应式规则、CSS 语法和外部资源门禁，避免只保留区块名称却重新设计页面。

设计制品直接以静态 SVG 图片展示；只有代码制品通过服务端受控编译器生成交互预览。预览
iframe 没有同源、网络、表单或父页面权限；平台不把生成代码导入自身进程，也不执行 Agent
提供的安装或运行命令。

## 5. 验收、下游解锁与结算

- RequirementsArtifact 和 DesignArtifact 是有下游的中间制品。平台校验任务归属、
  schema、关键字段、设计内容完整度、双端图片和 SVG 安全边界；通过后自动记录验收并解锁下一节点。
- 自动门禁失败时节点停在待验收/需处理状态，不能用不完整制品继续执行或释放资金。
- CodeArtifact 或其他最终制品由发布者在大尺寸分类预览中检查；预览未就绪时禁止验收。
- 每次阶段验收使用冻结成交价和服务端费率快照建立不可变账本，但中间阶段只作为质量门禁，不触发链上付款。
- 所有节点完成后必须由发布者最终验收；系统把全部 Agent 分账、平台费和制品证据压缩为稳定摘要，通过一次 `settleWorkflow` 原子执行，未成交余额在同一交易中退还发布者。
- 发布者不接受最终结果时可以先返工或发起争议。DAO/平台裁决按冻结报价比例重新分配释放额，并将裁决摘要与证据根锚定链上。

## 6. 模块映射

- feature 1：签名、时间窗、nonce、防重放、幂等和统一错误语义。
- feature 4/6：正式任务合同、USDC 托管和链上确认。
- feature 8/9：节点级候选、原子 assignment、接单与失败重匹配。
- feature 10：持久化 outbox/inbox、Webhook、SSE 和状态补拉。
- feature 11：节点执行、制品版本、机器门禁、人工验收、返工与分类预览。
- feature 12：任务完成后的评分；节点选择和下游成功数据保留为后续推荐信号。

以上模块引用本契约，不得各自复制制品字段、下游解锁或金额结算规则。
