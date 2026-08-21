---
description: Web 前端（web/ better-t-stack pnpm workspace, Next.js 16）开发规范
globs: web/**
---

# Frontend 规则

适用范围：`web/`（唯一正式 Web 工程，better-t-stack pnpm workspace，`packageManager: pnpm@11.18.0`）。`apps/web` 使用 Next.js 16、React 19、App Router、Tailwind CSS 和 Zod；`packages/ui` 提供共享基础组件；测试固定 Vitest + Testing Library；lint/格式化以 Biome 配置为准。

## 常用命令

- 安装依赖：`cd web && pnpm install`
- 本地开发：`cd web && pnpm dev:web`
- 测试：`cd web && pnpm test`
- 类型检查：`cd web && pnpm check-types`
- Lint/格式检查：`cd web && pnpm exec biome check .`（需要自动修复时才运行 `pnpm check`）
- 构建：`cd web && pnpm build`
- 以上命令需 Node.js 22+ 执行。

## 目录与结构

1. 正式 Web 代码只写入 `web/apps/web` 与 `web/packages/*`，不得新增 Vite 或其他平行前端工程。
2. 共享基础 UI（跨页面复用、无业务语义）放在 `web/packages/ui`；业务页面与业务组件放在 `web/apps/web`。
3. 避免只有转发调用、无增量价值的浅封装组件或 hook。

## 路由与组件模型

4. 使用 Next.js 16 App Router；HTTP 入口使用 Route Handlers。
5. 页面默认使用 Server Component，只有确有交互状态或浏览器 API 需求时才标记 `"use client"`。
6. 外部输入（表单、query、Route Handler 请求体）在边界用 Zod 校验，不得信任未校验的客户端数据进入业务逻辑或直接渲染。

## TypeScript 与状态

7. 保持 TypeScript strict；不使用 `any`、无依据类型断言（`as`）或非空断言（`!`）掩盖未知类型。
8. 涉及表单凭证（如 Agent 凭证、密钥字段）的组件，提交成功或失败后都必须清空明文状态，不得残留在 state 或 DOM 中。

## 测试

9. 组件与交互测试使用 Vitest + Testing Library，断言用户可观察行为（渲染结果、可访问性、错误提示），不得耦合内部调用顺序或实现细节。
10. 涉及表单凭证的测试须覆盖：提交后明文清空、字段级错误映射、网络失败路径；mock fetch 通过不得等同于真实 API 已联通（真实路由/认证参见 `.claude/CLAUDE.md` 当前实现缺口说明）。

## 提交前检查

11. 修改后运行 `pnpm test`、`pnpm check-types`、`pnpm exec biome check .`；涉及构建产物或路由改动需再运行 `pnpm build`。
12. 不得声称未实际执行的验证已通过；无法运行时说明原因及用户可执行命令。
