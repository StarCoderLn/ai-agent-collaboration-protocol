# Product Workflow Agents

这个包提供 PRD、产品设计、Coding 三个步骤，每个步骤各有三个可比较的 Agent。
九个 Agent 共用协议验签、模型客户端、制品 Schema 和正式回调，但每个 Agent 的执行顺序
都保存在独立文件中。平台通过稳定 `agentId` 派发，不按显示名称或目录名猜测实现。

## 九个 Agent 的核心代码

| 步骤 | Agent ID | 用户看到的名称 | 实现方式 | 核心文件 |
| --- | --- | --- | --- | --- |
| PRD | `prd-direct` | 快速需求整理 Agent | DeepSeek 单次结构化生成 | `src/agents/prd/direct-agent.ts` |
| PRD | `prd-mastra` | Mastra 需求分析 Agent | Mastra 规划 + 严格结构化生成 | `src/agents/prd/mastra-agent.ts` |
| PRD | `prd-state-machine` | 深度需求拆解 Agent | 分析、生成、评审、一次修复 | `src/agents/prd/state-machine-agent.ts` |
| 设计 | `design-direct` | 快速界面设计 Agent | DeepSeek 结构化 DesignSpec | `src/agents/design/direct-agent.ts` |
| 设计 | `design-mastra` | Mastra 产品设计 Agent | Mastra 规划 + 结构化 DesignSpec | `src/agents/design/mastra-agent.ts` |
| 设计 | `design-state-machine` | 设计评审与完善 Agent | 分析、生成、评审 + DesignSpec | `src/agents/design/state-machine-agent.ts` |
| Coding | `code-direct` | 快速代码生成 Agent | DeepSeek 直接生成 TSX | `src/agents/coding/direct-agent.ts` |
| Coding | `code-mastra` | Mastra 编程 Agent | Mastra 规划后生成 TSX | `src/agents/coding/mastra-agent.ts` |
| Coding | `code-state-machine` | 可靠前端开发 Agent | TSX 验收、CSS 继承、分段局部修复 | `src/agents/coding/state-machine-agent.ts` |

## 共享边界

- `src/catalog.ts`：九个 Agent 的稳定 ID、名称、标签、价格和平台 UUID，是目录信息的单一权威来源。
- `src/executors.ts`：只按 `agentId` 路由到上表文件，不包含任何模型执行分支。
- `src/agents/shared/contracts.ts`：九个实现共同遵守的窄执行接口和输入防御检查。
- `src/agents/shared/model-steps.ts`：Mastra 结构化输出与自研状态机共用的模型调用边界。
- `src/model-client.ts`：DeepSeek HTTP、超时、JSON 与源码解析、代码安全和视觉继承校验；可靠前端开发 Agent 会分别验收 TSX 与 CSS，只重试失败片段。
- `src/design-renderer.ts`：把已验证 DesignSpec 确定性渲染为桌面与移动 SVG 设计稿。
- `src/formal-dispatch.ts`：正式任务的 202 接单、ack、进度、结果与返工回调。
- `src/domain.ts`：PRD、设计和代码制品的 Zod Schema 与可信元数据装配。

正式任务不会让三个节点各自重新理解原始需求。PRD 节点输出经机器门禁验收后，完整
`RequirementsArtifact` 会进入设计节点；设计节点输出经门禁验收后，完整 DesignSpec 和
需求制品会一起进入 Coding 节点。任何新 Agent 实现都必须用任务特异性测试证明这条继承
链路，不能只传标题、摘要或通用提示词。

三个设计 Agent 只生成结构化 DesignSpec，不再生成或执行任意 TSX、CSS、HTML 与 SVG。
可信平台渲染器根据同一份规范确定性生成 1440 桌面端和 390 移动端 SVG，作为用户主要验收
产物；Coding Agent 同时消费完整 DesignSpec 和这两张实际 SVG 设计稿。Direct 与 Mastra
候选成对生成 `app/page.tsx` 和 `app/globals.css`；可靠前端开发 Agent 会先验收 TSX，再把
这份源码原样交给 CSS 步骤。平台拒绝缺失设计文案、设计颜色、响应式规则或包含
外部 CSS 资源的结果；`data-design-id` 仅作为可选调试钩子，不会让可运行产物验收失败。
因此图片、机器规范和最终代码共享一个事实源，同时仍能让
不同 Coding Agent 真实体现视觉实现能力。

## 为什么仍然是一个 package

这些 Agent 使用同一套接入协议和部署生命周期。保留单 package 可以避免复制九份密钥、
端口、协议验签和回调实现；按步骤和 Agent 拆分核心文件，则让实现可独立阅读、测试和替换。
后续若某个 Agent 需要独立扩缩容，可以保持相同协议端点和 ID，将对应实现迁移为独立服务。

## 验证

本目录要求 Node.js 22。仓库当前可用的直接验证命令是：

```bash
pnpm test
pnpm check
pnpm build
```
