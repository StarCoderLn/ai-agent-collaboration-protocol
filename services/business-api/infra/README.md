# `services/business-api` 部署（AWS CDK）

独立部署的 Next.js API-only 应用（仅 `app/api/**` Route Handlers，无页面），承载为
AWS Lambda + Function URL。方案选型见 `specs/2.agent-registration/tasks.md` T-009
的决策记录：AWS Lambda Web Adapter（LWA）+ zip 打包（不用容器镜像）+ AWS CDK
（不用 SAM——本项目已知会有多个 Lambda，CDK 更适合共享配置）。

同一个栈还创建 Feature 12 的 EventBridge 定时评分快照：每小时通过 API Destination
调用 `/api/internal/workers/score-snapshots`，Bearer token 存在 EventBridge Connection
管理的 secret 中，不进入定时事件正文。仓储优先选择从未计算或最久未更新的 Agent，
因此超过单批 100 个时会分轮覆盖，而不是永远只刷新 ID 最小的一批。

## 前置条件

- Node.js 22+、pnpm（与项目其余部分一致）。
- 已配置好目标 AWS 账号的凭据（`aws configure` 或 SSO），本仓库不内置任何账号信息。
- 首次在某个 AWS 账号/区域部署 CDK 前需要 `npx cdk bootstrap`（一次性，创建 CDK 自身
  需要的 S3 bucket 等资源）。

## 必需的运行时配置（环境变量）

以下 7 个值部署前必须在 shell 里提供，缺失会在 `cdk synth`/`cdk deploy` 阶段直接
报错（不会部署出一个环境变量为空、运行时才报错的 Lambda，见
`lib/business-api-stack.ts` 的 `requireEnv`）：

| 环境变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `AGENT_CREDENTIALS_KMS_KEY_ID` | 信封加密用的 KMS Key ID/Alias |
| `SIWE_EXPECTED_DOMAIN` | SIWE 消息校验的域名 |
| `SIWE_EXPECTED_URI` | SIWE 消息校验的 URI，也是 CORS `Access-Control-Allow-Origin` 的来源 |
| `SIWE_EXPECTED_CHAIN_ID` | SIWE 消息校验的链 ID |
| `DISPATCH_ENGINE_URL` | Go 分发引擎的内部服务地址，只供 Lambda 服务端调用 |
| `DISPATCH_INTERNAL_TOKEN_SECRET_ARN` | 保存内部高熵 token 原文的 AWS Secrets Manager secret ARN；CDK 通过动态引用把它注入 Lambda 和 EventBridge Connection，真实 token 不进入 synth 模板 |

该 secret 的 **SecretString 必须就是 token 原文**（不是 JSON，也不要包含 `Bearer ` 前缀），
并与分发引擎配置使用同一个值。`DISPATCH_INTERNAL_TOKEN` 仍是本地运行 Business API 时的
环境变量名；只有 CDK synth/deploy 输入改为 secret ARN，以免凭据落入 `cdk.out`。

用环境变量而不是 CDK `--context`：`infra:deploy`/`infra:synth` 是
`pnpm infra:build-lambda && cd infra && npx cdk ...` 这样的复合 npm script，
`pnpm run <script> -- --context k=v` 的参数无法正确穿透到复合命令里的最后一条子命令
（已实测复现，`--context` 会丢失）；环境变量前缀对复合 shell 命令天然有效，不受这个
限制，见下方命令示例。

**不要把真实凭据提交进仓库**，也不要写进任何已跟踪的文件。

## 常用命令（均在 `services/business-api` 目录下执行）

```bash
# 本地构建 Lambda 部署包（next build + 打包脚本），不接触 AWS
pnpm infra:build-lambda

# 生成 CloudFormation 模板并预览，不接触 AWS（除非本地已配置的 AWS 凭据被 CDK 用来
# 读取账号/区域信息——不会创建任何资源）
DATABASE_URL=... AGENT_CREDENTIALS_KMS_KEY_ID=... SIWE_EXPECTED_DOMAIN=... \
  SIWE_EXPECTED_URI=... SIWE_EXPECTED_CHAIN_ID=... DISPATCH_ENGINE_URL=... \
  DISPATCH_INTERNAL_TOKEN_SECRET_ARN=... pnpm infra:synth

# 对比当前部署状态与本地代码的差异，不接触 AWS 之外只读取现有 stack 状态
DATABASE_URL=... AGENT_CREDENTIALS_KMS_KEY_ID=... SIWE_EXPECTED_DOMAIN=... \
  SIWE_EXPECTED_URI=... SIWE_EXPECTED_CHAIN_ID=... DISPATCH_ENGINE_URL=... \
  DISPATCH_INTERNAL_TOKEN_SECRET_ARN=... pnpm infra:diff

# 真正创建/更新 AWS 资源——执行前必须先取得用户明确同意，见 AGENTS.md 第 10 节
DATABASE_URL=... AGENT_CREDENTIALS_KMS_KEY_ID=... SIWE_EXPECTED_DOMAIN=... \
  SIWE_EXPECTED_URI=... SIWE_EXPECTED_CHAIN_ID=... DISPATCH_ENGINE_URL=... \
  DISPATCH_INTERNAL_TOKEN_SECRET_ARN=... pnpm infra:deploy
```

## 打包方案说明

`infra/build-lambda.sh` 把 `next build`（`output: "standalone"`）的产物整理成一个
CDK 能直接 `Code.fromAsset()` 的目录：

1. `next build` 产出 `.next/standalone`（自包含运行时，含最小化 `node_modules`）。
2. 用 `cp -rL` 把 `.next/standalone` 复制到 `infra/.dist/lambda`，`-L` 解析 pnpm 的
   符号链接为真实文件（pnpm 的 `node_modules` 默认是指向 `.pnpm/` 虚拟存储的相对路径
   符号链接，整体搬到别处会变成悬空链接）。
3. 补齐 pnpm 顶层依赖别名缺口：`-L` 把 `next` 从它在 `.pnpm/next@<ver>/node_modules/`
   里的原始位置"拍平"到了顶层，导致它与同一个 pnpm 条目里的兄弟包（`@next/env`、
   `styled-jsx` 等）失去目录相邻关系，Node 的模块解析找不到就报
   `Cannot find module`（本地实测复现过）。这些包其实都在 pnpm 自己维护的别名暂存
   目录 `node_modules/.pnpm/node_modules/` 里，脚本会把它们逐个补到顶层。
4. 手动补 `.next/static`（`standalone` 输出默认不含，Next.js 官方文档要求单独复制）
   和 `public/`（当前项目没有该目录）。
5. 复制 `run.sh` 作为 Lambda Handler（`AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap` 指向它，
   由 LWA Layer 提供该 wrapper）。
6. 把 `.next/cache` 软链到 `/tmp/cache`——Lambda 部署包本身只读，`/tmp` 是唯一可写
   目录，`run.sh` 会确保该目录存在。

参考实现：AWS 官方 Next.js zip 示例
（<https://github.com/aws/aws-lambda-web-adapter/tree/main/examples/nextjs-zip>），
本项目的差异只是把 SAM CLI 的 Makefile 构建流程改写成独立脚本 + CDK。

## 已验证 / 未验证

- ✅ 本地跑通 `infra/build-lambda.sh` 产出的部署包：用 `node server.js` 直接启动，
  `GET /api/health` 返回 200，缺少运行时环境变量的路由（如 `/api/auth/nonce`）
  按设计优雅返回 500 而不是让进程崩溃。
- ✅ `cdk synth` 产出的 CloudFormation 模板经人工检查，`Outputs.BusinessApiFunctionUrl`
  正确引用 `AWS::Lambda::Url` 资源的 `FunctionUrl` 属性（CDK 高层构造自动处理，
  不是手写 `Fn::GetAtt` 拼错属性名）。
- ✅ 环境变量缺失时 `cdk synth` 按预期直接报错，不会用空值悄悄部署。
- ❌ **未在真实 AWS 账号执行过 `cdk deploy`**：Lambda 冷启动实际表现、LWA Layer 在
  真实环境下的行为、Function URL 的真实可达性、连接真实 PostgreSQL/KMS 均未验证。
- ❌ 未做真实浏览器的跨源请求验证（CORS 预检、`credentials:"include"` 的完整链路）。

这些未验证项需要具备 AWS 账号权限的人工执行一次 `cdk bootstrap` + `cdk deploy` 才能
确认，属于本 task 范围之外的环境级验证（与项目 `.claude/rules/testing.md` 的既有原则
一致：本地/单元验证不能代替真实环境验证）。
