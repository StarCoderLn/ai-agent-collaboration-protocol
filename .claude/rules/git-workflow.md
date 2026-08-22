---
description: 项目 Git 提交、分支与提交前验证规范
---

# Git 工作流

项目已进入编码阶段，以下规则同时适用于文档、Go、TypeScript/Next.js、SQL 和后续合约代码。

## 提交前检查

- 提交前先 `git status` 确认改动范围，避免把无关文件（尤其是可能包含密钥的文件）带入提交。
- 只暂存与当前任务相关的文件，避免 `git add -A` / `git add .` 误加临时文件或敏感文件。
- 不得提交占位凭据、真实密钥、`.env` 等敏感文件；如需引用配置，使用示例文件（如 `.env.example`）。

## 提交粒度与信息

- 每次提交聚焦单一变更目的（如单个 feature 的 requirements/design/tasks，或单个 PLAN.md 决策更新），不混合无关改动。
- 提交信息说明"为什么改"而非单纯罗列改了什么文件；文档类改动需说明对应的 feature 或决策背景。
- 涉及 `specs/` 下 feature 文档变更时，提交信息注明 feature 名称，便于追溯。

## 分支策略

- 默认在 `main` 上直接提交文档类变更（PRD、设计系统、规则文件），除非用户要求走 PR 流程。
- 进入代码实现阶段后，涉及公共接口、数据库 schema、认证、资金、并发或跨模块的改动应走独立分支 + PR，禁止直接提交到 `main`。
- 分支使用 `feature/<feature-id>-<short-name>`、`fix/<scope>-<short-name>` 或 `docs/<short-name>`；高影响代码变更走独立分支和 PR。

## 禁止操作

- 不得使用 `push --force`、`reset --hard`、`checkout .`、`clean -f` 等破坏性命令，除非用户明确要求。
- 不得跳过 hooks（`--no-verify` 等），除非用户明确要求。
- 不得对已有提交做 `--amend`，除非用户明确要求；默认创建新提交。

## Go 代码改动前置检查（services/dispatch-engine）

- 提交涉及 `services/dispatch-engine` 下代码前，在该目录执行并确认通过：
  - `go build ./...`
  - `go test ./...`
  - `go vet ./...`（尚无 golangci-lint 配置，`go vet` 为当前唯一 lint 前置检查）
- 未实际执行上述命令时，不得在提交信息或对话中声称已通过验证。
- 仓库暂无 CI 配置，以上检查需在本地手动执行。

## TypeScript / Next.js 提交前检查

- `services/business-api`：执行 `pnpm test`、`pnpm typecheck`、`pnpm build`。
- `web`：使用 Node.js 22+ 执行 `pnpm test`、`pnpm check-types`、`pnpm exec biome check .`、`pnpm build`。
- PostgreSQL、AWS Lambda/KMS 和 Ethereum 的真实环境验证尚未落地时，提交说明必须列出未验证项，不得用本地 mock 结果代替。
