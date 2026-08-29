# 正式多 Agent 工作流与制品契约

> 状态：v0.4 正式任务工作流权威契约
>
> 日期：2026-08-30
>
> 关联：`docs/prd.md` 2.1.1、feature 1、4、6、8～12

## 1. 目的与边界

本文档集中定义正式任务中跨 Agent 节点传递的制品知识，避免规划器、Agent、回调仓储
和前端分别解释同一份输入输出。任务、节点、分配、制品、验收与结算均以 PostgreSQL
持久化事实为准，前端只提供只读关系图和操作入口，不保存第二套工作流状态。

- USDC 托管确认与正式执行图创建处于同一事务；图创建失败时任务不能先进入旧匹配路径。
- 每个可执行节点独立生成候选、锁定 assignment、接单、执行、提交制品和结算。
- 下游只能消费已经验收的完整上游制品，禁止只传摘要后重新解释需求。
- 中间节点的结构化制品通过版本化机器门禁后自动推进；最终节点必须由发布者验收。
- 每个节点结算自己的成交金额，其余 USDC 留在同一 Escrow 中；工作流完成后退还余额。
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

- 软件任务：需求澄清与 PRD → 产品与界面设计 → Coding 开发实现。
- 图片/视频任务：需求澄清 → 图片或视频生成。
- 研究、文档和通用任务：生成一个与分类相符的交付节点。

PRD、设计和 Coding 每类提供三种可比较实现：

| 能力 | DeepSeek 直连 | Mastra 编排 | 自研状态机 |
| --- | --- | --- | --- |
| PRD | `prd-direct` | `prd-mastra` | `prd-state-machine` |
| 设计 | `design-direct` | `design-mastra` | `design-state-machine` |
| Coding | `code-direct` | `code-mastra` | `code-state-machine` |

三个实现使用同一 DeepSeek 模型，差异来自单次生成、多阶段 Mastra 编排和显式
分析/生成/校验/修复状态机。平台可以展示最多三个候选，但一次节点只锁定并执行一个
Agent，不会为了比较自动产生三倍调用和结算成本。

## 4. 制品依赖

```text
正式任务合同 ────────────────┐
      │                       │
      ▼                       │
RequirementsArtifact ───┐     │
      │                  │     │
      ▼                  │     │
DesignArtifact ──────────┴─────┤
                               ▼
                         CodeArtifact
```

Coding 节点必须同时接收需求和完整设计制品。每份制品包含 `schemaVersion`、`taskId`、
`generatedBy` 和 `generatedAt`；这些可信字段由代码补齐，不允许模型自行生成。派发层
同时传递上游节点 ID、结果 ID、输出契约、MIME 类型和完整内容或文件引用，以便 Agent
验证来源并保持链路可审计。

### 4.1 RequirementsArtifact

包含问题陈述、目标用户、目标/非目标、用户故事与验收标准、功能需求、约束、假设、
开放问题，以及带依赖和验收标准的可执行任务列表。

### 4.2 DesignArtifact

包含设计方向、设计 token、页面与区块、组件、交互状态、响应式和无障碍规则，以及
`prototype.pageTsx` 与 `prototype.globalsCss`。原型至少包含四个稳定的
`data-design-id`，用于证明 Coding Agent 保留了关键视觉结构。

### 4.3 CodeArtifact

包含实现摘要、文件树、代码文件、运行说明、测试计划和已知限制。Coding Agent 必须从
设计原型增量实现交互，原样继承 `globals.css` 并保留全部设计锚点，不能重新设计页面。

设计与代码制品只通过服务端受控编译器生成预览。预览 iframe 没有同源、网络、表单或
父页面权限；平台不把生成代码导入自身进程，也不执行 Agent 提供的安装或运行命令。

## 5. 验收、下游解锁与结算

- RequirementsArtifact 和 DesignArtifact 是有下游的中间制品。平台校验任务归属、
  schema、关键字段、设计锚点和危险运行能力；通过后自动记录验收并解锁下一节点。
- 自动门禁失败时节点停在待验收/需处理状态，不能用不完整制品继续执行或释放资金。
- CodeArtifact 或其他最终制品由发布者在大尺寸分类预览中检查；预览未就绪时禁止验收。
- 每次验收使用冻结成交价和服务端费率快照计算里程碑金额，链上确认后才计入已释放额。
- 所有节点验收后执行 Escrow finalize，把未成交或整数拆分产生的余额退还发布者。

## 6. 模块映射

- feature 1：签名、时间窗、nonce、防重放、幂等和统一错误语义。
- feature 4/6：正式任务合同、USDC 托管和链上确认。
- feature 8/9：节点级候选、原子 assignment、接单与失败重匹配。
- feature 10：持久化 outbox/inbox、Webhook、SSE 和状态补拉。
- feature 11：节点执行、制品版本、机器门禁、人工验收、返工与分类预览。
- feature 12：任务完成后的评分；节点选择和下游成功数据保留为后续推荐信号。

以上模块引用本契约，不得各自复制制品字段、下游解锁或金额结算规则。
