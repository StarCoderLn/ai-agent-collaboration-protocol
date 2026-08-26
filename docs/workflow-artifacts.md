# Agent 比较工作流与制品契约

> 状态：v0.1 体验闭环权威契约
> 日期：2026-08-22
> 关联：`docs/prd.md` 2.1.1、feature 1、4、8、9、11、12

## 1. 目的与边界

本文档集中定义「PRD → 设计 → Coding」体验工作流中会跨步骤传递的知识，避免把同一
状态和 schema 复制到多个 feature。它是体验层的权威契约，不替代正式交易任务状态机。

- 体验运行真实调用已接入协议 v1.0 的 Agent。
- 每步恰好展示 3 个真实候选，但只执行用户选中的 1 个。
- 下游输入只接受已经通过 schema 校验、并由用户验收的上游制品。
- 体验运行不创建托管、结算、返工或争议记录。
- Mastra、DeepSeek SDK 或自研状态机的内部对象不得进入公共制品。

体验页使用一个固定三节点的可拖拽画布：用户把右侧候选 Agent 拖入对应的 PRD、设计或
Coding 节点，也可通过同一张候选卡片的按钮完成键盘操作；节点位置允许调整，但节点
类型、依赖方向和执行顺序不可改变。该画布用于验证手动编排交互，不等同于后续支持
自由分支、循环和任意节点类型的通用工作流编辑器。

## 2. 工作流状态

体验页面只使用以下互斥状态；它们不能写入 feature 4 的正式 `tasks.status`：

```text
editing_requirements
  → running_requirements
  → reviewing_requirements
  → running_design
  → reviewing_design
  → running_code
  → reviewing_code
  → completed
```

任意 `running_*` 可进入同一步的 `failed` 展示状态并重试。上游重新执行后，已有下游
制品立即标记为 `stale` 且不得继续作为输入，直到下游重新执行。

## 3. 候选 Agent

每个能力类别固定提供三种可比较实现：

| 能力 | DeepSeek 直连 | Mastra 编排 | 自研状态机 |
| --- | --- | --- | --- |
| PRD | `prd-direct` | `prd-mastra` | `prd-state-machine` |
| 设计 | `design-direct` | `design-mastra` | `design-state-machine` |
| Coding | `code-direct` | `code-mastra` | `code-state-machine` |

三个实现使用同一 DeepSeek 模型。差异只来自编排方式：单次生成、多阶段框架编排、显式
分析/生成/校验/修复状态机。UI 必须展示该差异，不能把三个名字不同但执行器相同的实例
当作三个候选。

## 4. 制品依赖

```text
原始用户需求 ────────────────┐
      │                       │
      ▼                       │
RequirementsArtifact ───┐     │
      │                  │     │
      ▼                  │     │
DesignArtifact ──────────┴─────┤
                               ▼
                         CodeArtifact
```

代码步骤必须同时接收需求和设计制品，不能只依赖设计步骤的摘要。每份制品包含
`schemaVersion`、`taskId`、`generatedBy` 和 `generatedAt`；这些可信字段由代码补齐，
不允许模型自行生成。

### 4.1 RequirementsArtifact

包含问题陈述、目标用户、目标/非目标、用户故事与验收标准、功能需求、约束、假设、
开放问题，以及带依赖和验收标准的可执行任务列表。

### 4.2 DesignArtifact

包含设计方向、设计 token、页面与区块、扁平组件树、交互状态、响应式规则、素材计划
和 SVG 预览。模型只生成结构化设计数据；SVG 由可信代码模板生成并转义文本，不直接
执行模型输出的 SVG/HTML。

### 4.3 CodeArtifact

包含实现摘要、文件树、代码文件、运行说明、测试计划和已知限制。体验版只展示和下载
代码制品，不直接写入平台仓库，也不执行模型生成的命令；未来必须在隔离沙箱中执行。

## 5. 与现有 feature 的映射

- feature 1：继续提供签名、时间窗、nonce、防重放和幂等语义。
- feature 4：未来用正式任务草稿替换体验页原始输入；正式任务状态不变。
- feature 8：未来用平台注册、健康且满足硬约束的候选替换固定的 9 个自建候选。
- feature 9/10：未来用异步派发和状态事件替换当前同步体验适配器。
- feature 11：未来持久化制品版本和用户验收；制品 schema 保持版本化。
- feature 12：未来记录盲评、用户选择和下游成功；体验版不生成正式 Agent 分数。

上述 feature 只引用本文档，不各自复制工作流状态或制品字段。
