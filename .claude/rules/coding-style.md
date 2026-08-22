---
description: 文档、Go 与 TypeScript/Next.js 编码风格规范
globs: "**/*.md"
---

# 文档写作风格

项目已进入编码阶段。项目级技术栈以 `docs/prd.md` 第 10 节和 `specs/PLAN.md` 为权威来源；实现缺口不得被表述为技术栈未定。

## 基本要求

1. 所有文档使用 Markdown,标题层级从 `#` 开始,不跳级。
2. 中文行文,专有名词、代码标识符、命令保留英文原文,不强行翻译。
3. 术语与命名一旦在 PRD 或 design.md 中确定,后续文档必须保持一致,不得同义替换(如「Agent」不与「代理」混用)。
4. 规格文档(requirements.md/design.md/tasks.md)中的验收标准必须可核验,避免「体验良好」「性能优秀」等无法验证的表述。
5. 决策类内容(如高影响任务决策摘要)按 `AGENTS.md` 规定的结构记录,不自创格式。
6. 新增或修改文档时保持最小合理范围,不顺带重写无关章节。
7. 文档中如涉及尚未确认的技术栈、命令或目录结构,须明确标注为待定,不得虚构。

## TypeScript / Next.js 代码风格

1. 正式 Web 代码只写入 better-t-stack 的 `web/apps/web` 与 `web/packages/*`，不得新增 Vite 或其他平行前端。
2. 使用 Next.js 16 App Router；HTTP 入口使用 Route Handlers，页面默认使用 Server Component，只有交互或浏览器 API 确有需要时才标记 Client Component。
3. 保持 TypeScript strict，不使用 `any`、无依据类型断言或非空断言掩盖未知；外部输入在边界用 Zod 校验。
4. 共享基础 UI 放在 `web/packages/ui`，业务页面与业务组件放在 `web/apps/web`；避免只有转发作用的浅封装。
5. 格式与 lint 以 Biome 配置为准；修改后运行 `pnpm exec biome check .`，需要自动修复时才运行 `pnpm check`。
6. 组件和交互测试使用 Vitest + Testing Library，断言用户可观察行为，不耦合内部调用顺序。

## Go 代码风格(services/dispatch-engine)

项目已存在 Go 后端服务 `services/dispatch-engine`(module `github.com/StarCoderLn/ai-agent-collaboration-protocol/services/dispatch-engine`,Go 1.26.5,标准库风格,无外部 web 框架,无 Makefile/CI 配置)。以下规则约束该模块的代码风格,不覆盖上文文档写作规范。

1. 提交前必须执行 `gofmt`/`go vet ./...` 保证格式化与静态检查通过;未发现 `golangci-lint` 配置前不得虚构其规则或命令。
2. 包名小写、简短、无下划线;导出标识符必须有符合 Go 惯例的 doc comment(以标识符名称开头)。
3. 错误处理遵循标准库惯例:显式返回 `error`,使用 `fmt.Errorf("...: %w", err)` 包装以保留链路,不得吞掉错误或用 `panic` 代替正常错误返回。
4. 涉及协议签名、幂等性、版本校验等 `internal/protocol` 包的契约行为,修改前必须先看已有的 `*_test.go` 建立行为基线,重构与行为变更分开进行。
5. 新增功能必须配套单元测试(`_test.go`),测试与实现放在同一包内(白盒)或 `_test` 后缀包(黑盒),按已有文件惯例选择。
6. 完成修改后必须执行 `go build ./...` 与 `go test ./...`,只报告实际执行过的结果;无法执行时说明原因。
7. 不引入外部依赖或框架,除非已在 `go.mod` 中存在或用户/PLAN.md 明确决策;标准库优先。
