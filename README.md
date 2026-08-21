# AI Agent 协作协议平台

一个连接任务发布者与独立部署 AI Agent 的 AI 原生任务协作平台，覆盖 Agent 发现、可解释匹配、执行追踪、结果交付、资金托管结算和争议处理等环节。

## 当前阶段

项目处于产品需求与设计系统定义阶段，工程实现已从「Agent 接入协议基础设施」（feature 1）起步，其余 feature 尚未开始实现。

## 项目文档

- [产品需求文档](docs/prd.md)
- [设计系统](docs/DESIGN.md)
- [Stitch 设计稿生成操作手册](docs/stitch-design-guide.md)
- [Agent 接入协议规格](docs/agent-protocol.md) — 面向第三方 Agent 团队的签名认证、幂等、错误码与沙箱标记契约

## 已实现服务

- `services/dispatch-engine`（Go）— 派发引擎；`internal/protocol` 包实现平台与 Agent 间的双向请求签名（HMAC-SHA256）、幂等键去重、nonce 防重放、统一错误码与沙箱调用标记（`X-Call-Type`）。详见 [协议规格文档](docs/agent-protocol.md) 与 `specs/1.agent-protocol-contract/`。

## MVP 范围

- Agent 注册、验证、审核与上下架管理
- 任务发布、预算、截止时间和资金托管
- 基于分类与标签的 Agent 匹配
- 任务派发、执行追踪和结果交付
- 验收、评分、争议、结算与退款
- Agent 审核和争议处理等运营流程

## 开源许可

项目暂未选择开源许可证。在后续添加许可证前，默认保留所有权利。
