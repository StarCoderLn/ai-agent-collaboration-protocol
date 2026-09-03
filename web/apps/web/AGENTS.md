<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Feature 工程教训

- [2.agent-registration/T-006] 嵌套服务端字段错误须显式映射到扁平表单字段。
- [2.agent-registration/T-007] PATCH 只提交实际变更字段，避免审计摘要把未变化字段记为变更。
- [2.agent-registration/T-007] 脚手架转正须在同一/紧邻 task 迁移旧页面，避免同 feature 出现互不连通的多个前端 App。
- [2.agent-registration/T-007] 排"编辑/查看页" task 须先确认对应 GET 读取端点已有独立任务，否则页面无法端到端可用。
- [2.agent-registration/T-007] 跨源 SIWE 场景 fetch 默认 credentials:"same-origin" 漏发 session cookie，须显式设 include。
- [2.agent-registration/T-007] 依赖路由参数(如 agentId)的 useEffect fetch 须用 AbortController 防旧请求覆盖新状态。
- [6.escrow-sync-and-wallet] injected 钱包连接器只允许在用户主动操作时惰性注册。
