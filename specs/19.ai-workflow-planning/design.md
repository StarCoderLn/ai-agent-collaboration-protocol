# AI 工作流规划设计

## 1. 状态边界

`task_workflow_plan_revisions` 追加保存 `template/ai/user` 修订，
`task_workflow_plan_heads` 保存当前修订、状态和乐观锁版本。草案与
`task_workflow_runs/nodes/edges` 分离；发布者确认时才在同一事务中创建正式 DAG 并把 head
锁定为 `confirmed`。

```text
任务提交 -> 初始草案 -> AI/用户追加修订 -> 用户确认 -> 正式 DAG -> 逐节点匹配
              planning 草案区                         现有交易状态机
```

模型服务、浏览器和 Marketplace API 都不能直接写候选、报价或资金表。确认事务失败时，草案
保持可编辑且不留下半张正式图。

## 2. 模型与 LangGraph

`WorkflowModelClient` 是产品工作流的唯一模型端口，隐藏 base URL、密钥、模型名和
OpenAI-compatible 响应格式。`WORKFLOW_MODEL_PROVIDER=deepseek|openai` 配合统一 Key、URL
和 model 变量完成切换；遗留 DeepSeek 变量只在 DeepSeek 模式兼容读取。

LangGraph 图为 `generate -> inspect -> repair once -> complete`。模型只生成候选 JSON；Zod
负责字段边界，确定性代码负责拓扑合法性。PostgreSQL checkpoint 用于恢复模型规划步骤，
不替代业务草案表。

## 3. 服务接口

Marketplace API 提供读取、保存、生成和确认四组 Hono 路由。API 到 Product Workflow Agent
使用 AICP v1 HMAC 原始字节签名，不共享模型 Key。模型调用位于事务外；返回结果保存时再次
校验 head version，避免慢模型结果覆盖用户的新编辑。

规划协议固定 `workflow-plan-v2`。Marketplace API 从 active Agent 及
`agent_workflow_contracts` 读取实时分类和输入/输出契约，按节点类型形成不可拆分的能力组合；
模型只能选择这些完整组合，不能把不同 Agent 的类型、输入和输出字段混搭。两个服务分别在
边界执行运行时 Schema 校验；版本不匹配直接失败，避免字段含义漂移后静默接受。

## 4. 编辑器

React Flow 只编辑草案中的节点和依赖。画布坐标属于当前浏览器视图，不进入业务 JSON；
节点数组顺序决定正式 `positionIndex`。保存只在用户显式操作时追加修订；确认按钮会先保存
尚未保存的真实变化，未变化时直接确认当前版本，避免重复审计修订。

新增阶段以当前选中节点为插入点：原有 `A -> B` 自动改写为 `A -> N -> B`，多条出边统一
从新节点继续分发，末尾新增则直接延长流程。新节点默认透传上游成果契约，避免先制造孤立
节点再要求用户手工修复。删除影响通过模态确认展示；历史内部契约保留原值但只显示中文
业务名称。新 AI 草案的输入输出必须来自规划协议登记的成果类型，未知类型在模型边界拒绝。
新增节点可以保留默认文案并保存草案；正式确认前，浏览器和服务端共同拒绝仍含默认名称、
工作说明或能力描述的阶段，避免占位节点进入选人、报价与执行链路。

确认后复用原正式关系图。正式图只读展示节点、候选和分配，不允许用拖拽改写交易事实。
逐阶段确认成功后，界面按 `positionIndex` 聚焦下一未选节点；失败不移动焦点。一键采用推荐
只发送任务级意图，服务端从每个未选节点的最新冻结候选快照读取第一名及报价。任务、run、
节点和候选在同一事务中加锁，已有选择保持不变；任一阶段无有效推荐则整批回滚。全部选定后
计算准确总价并进入 `awaiting_escrow`，该事务不创建 escrow intent 或 assignment。

## 5. 失败与恢复

- 模型不可用：保留当前草案，用户可以继续手工编辑或重试。
- 非法拓扑：服务端返回明确校验错误，不写新修订。
- version 冲突：拒绝覆盖，客户端刷新权威版本。
- 确认事务失败：正式 DAG 与锁定状态共同回滚。
- 执行能力漂移：确认事务以共享锁重新检查每个阶段的分类和输入/输出契约；任一阶段没有
  active Agent 时返回具体阶段名称，不创建正式 DAG。
- 历史错误计划：只有任务、计划头和正式 run 均仍为 `planning/confirmed/planning`，且没有
  选人、分配、托管、交付、验收、反馈或争议事实时，才允许恢复为草案。恢复事务先把计划、
  DAG、候选、曝光和 V2 影子记录写入 `workflow_plan_recovery_archives`，再移除可重建的活动
  投影；计划修订和恢复审计不可覆盖。
- 已确认或任务状态已推进：所有草案修改接口返回锁定错误。
