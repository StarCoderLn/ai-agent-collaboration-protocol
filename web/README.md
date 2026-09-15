# 正式 Web 工程

本目录由 better-t-stack 生成，是项目唯一正式 Web 工程。禁止在 `services/` 或其他目录新建 Vite、CRA 等平行前端。

## 固定技术栈

- `apps/web`：Next.js 16、React 19、TypeScript strict 和 App Router 前端
- `apps/server`：better-t-stack Hono Marketplace API，独立承载业务、认证和数据库边界
- `packages/ui`：Tailwind CSS 与共享 UI 组件
- `packages/env`：Zod 环境变量校验
- pnpm 11 workspace、Biome、Vitest + Testing Library

## 本地开发

需要 Node.js 22 或更高版本。在本目录安装依赖：

```bash
pnpm install
```

启动正式应用：

```bash
pnpm dev:web
```

浏览器访问 [http://localhost:3001](http://localhost:3001)。

## UI 开发约定

- 页面和业务组件放在 `apps/web`。
- 可跨页面复用的基础组件放在 `packages/ui/src/components`。
- 设计 token 和全局样式在 `packages/ui/src/styles/globals.css` 维护。
- 外部输入在边界使用 Zod 校验，不用 TypeScript 类型替代运行时校验。

共享组件导入示例：

```tsx
import { Button } from "@web/ui/components/button";
```

## 目录结构

```
web/
├── apps/
│   ├── web/         # 唯一正式 Next.js 用户界面
│   └── server/      # 独立 Hono Marketplace API
├── packages/
│   ├── env/         # 环境变量 schema
│   └── ui/          # 共享 UI 与样式
```

## 验证命令

- `pnpm test`：运行 Vitest 测试
- `pnpm check-types`：运行 TypeScript 类型检查
- `pnpm exec biome check .`：只读检查格式与 lint
- `pnpm check`：用 Biome 自动修复可修复问题
- `pnpm build`：构建全部 workspace 包
