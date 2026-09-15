# `web/apps/server` 部署（AWS CDK）

better-t-stack workspace 中的 Hono Marketplace API，独立部署为 AWS Lambda + Function
URL。Hono AWS Lambda Adapter 直接转换 API Gateway v2 事件，esbuild 生成单文件 zip
制品；IaC 使用 AWS CDK，继续保持业务 API 与前端不同的数据库/KMS 权限边界。

同一个栈还创建 Feature 12 的 EventBridge 定时评分快照：每小时通过 API Destination
调用 `/api/internal/workers/score-snapshots`，Bearer token 存在 EventBridge Connection
管理的 secret 中，不进入定时事件正文。仓储优先选择从未计算或最久未更新的 Agent，
因此超过单批 100 个时会分轮覆盖，而不是永远只刷新 ID 最小的一批。

评分提交、Agent 接单、最终结算和仲裁执行确认会在原业务事务内合并写入
`agent_score_refresh_requests`。分发服务每 5 秒调用
`/api/internal/workers/score-refresh-requests`，只重算受影响的 Agent；EventBridge 周期任务
继续负责时间衰减、近期窗口和停机漏发的最终校准。部署新应用前必须先执行 0054 migration，
否则任务事件写入无法引用刷新请求表。

> **生产资金执行阻塞项：** 当前仓库支持 Anvil 的 `local-unlocked` operator，以及已用于
> 本机 Sepolia 验收的 Web3 Secret Storage 加密 keystore operator；生产环境会拒绝
> `local-unlocked`，但 CDK 尚未配置 KMS/HSM 链上签名器。上线前必须实现托管式
> `EscrowOperatorClient`、授予最小签名权限并在目标环境验证 raw transaction、重试、轮换
> 与恢复；Agent 凭证加密使用的 KMS key 不能代替链上资金签名 key。

## 前置条件

- Node.js 22+、pnpm（与项目其余部分一致）。
- 已配置好目标 AWS 账号的凭据（`aws configure` 或 SSO），本仓库不内置任何账号信息。
- 首次在某个 AWS 账号/区域部署 CDK 前需要 `pnpm exec cdk bootstrap`（一次性，创建 CDK 自身
  需要的 S3 bucket 等资源）。

## 必需的运行时配置（环境变量）

以下配置部署前必须在 shell 里提供，缺失会在 `cdk synth`/`cdk deploy` 阶段直接
报错（不会部署出一个环境变量为空、运行时才报错的 Lambda，见
`lib/marketplace-api-stack.ts` 的 `requireEnv`）：

| 环境变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串 |
| `AGENT_CREDENTIALS_KMS_KEY_ID` | 信封加密用的 KMS Key ID/Alias |
| `SIWE_EXPECTED_DOMAIN` | SIWE 消息校验的域名 |
| `SIWE_EXPECTED_URI` | SIWE 消息校验的 URI，也是 CORS `Access-Control-Allow-Origin` 的来源 |
| `SIWE_EXPECTED_CHAIN_ID` | SIWE 消息校验的链 ID |
| `DISPATCH_ENGINE_URL` | Go 分发引擎的内部服务地址，只供 Lambda 服务端调用 |
| `DISPATCH_INTERNAL_TOKEN_SECRET_ARN` | 保存内部高熵 token 原文的 AWS Secrets Manager secret ARN；CDK 通过动态引用把它注入 Lambda 和 EventBridge Connection，真实 token 不进入 synth 模板 |
| `ETHEREUM_RPC_URL` | 目标 EVM 网络的服务端 RPC 地址 |
| `ESCROW_CHAIN_ID` | 与 RPC、Escrow 和 USDC 地址共同核对的链 ID |
| `ESCROW_CONTRACT_ADDRESS` | 当前网络部署的 USDC Escrow 地址 |
| `ESCROW_PAYMENT_TOKEN_ADDRESS` | 当前网络核对过的官方 USDC 地址 |
| `ESCROW_START_BLOCK` | Escrow 部署区块；同步器从该区块开始扫描 |
| `ESCROW_REQUIRED_CONFIRMATIONS` | 生产环境明确选择的确认阈值 |

YD 不属于资金结算配置：Marketplace API 内置了经 Sepolia RPC 核验的公开部署元数据，
只把它作为余额目录返回。将来 YD 重新部署时，才需要同时提供 `YD_TOKEN_CHAIN_ID`、
`YD_TOKEN_ADDRESS` 和 `YD_TOKEN_DECIMALS` 覆盖默认值。

DAO 质押使用独立的 `ARBITRATION_DAO_YD_TOKEN_ADDRESS`，并由服务端核对它与
`ArbitrationDAO.ydToken()` 一致。本地 Anvil 可将该变量指向 `TestYD`，但不得通过
`YD_TOKEN_*` 覆盖工作台展示的 Sepolia 产品 YD；正式 Sepolia 部署时两者才指向同一合约。

该 secret 的 **SecretString 必须就是 token 原文**（不是 JSON，也不要包含 `Bearer ` 前缀），
并与分发引擎配置使用同一个值。`DISPATCH_INTERNAL_TOKEN` 仍是本地运行 Marketplace API 时的
环境变量名；只有 CDK synth/deploy 输入改为 secret ARN，以免凭据落入 `cdk.out`。

用环境变量而不是 CDK `--context`：`infra:deploy`/`infra:synth` 是
`pnpm infra:build-lambda && cd infra && pnpm exec cdk ...` 这样的复合 npm script，
`pnpm run <script> -- --context k=v` 的参数无法正确穿透到复合命令里的最后一条子命令
（已实测复现，`--context` 会丢失）；环境变量前缀对复合 shell 命令天然有效，不受这个
限制，见下方命令示例。

**不要把真实凭据提交进仓库**，也不要写进任何已跟踪的文件。

## 常用命令（均在 `web/apps/server` 目录下执行）

```bash
# 本地构建 Hono Lambda 单文件制品，不接触 AWS
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

## LocalStack 全链路环境

没有 AWS 账号时，使用锁定的 `localstack/localstack:2026.08.2` 镜像验证
CloudFormation、Lambda、SQS、SNS、KMS、Secrets Manager、SSM 和 EventBridge。脚本直接
调用 Docker CLI，不依赖本机未安装的 Docker Compose 插件；不挂载持久卷，
避免 LocalStack 状态长期占用大量磁盘。Edge 端口只绑定宿主机 `127.0.0.1:4566`，
既满足 Colima 的 SSH 端口转发约束，也不会向局域网暴露模拟云服务。
若 Colima 0.10 的 hostagent 在端口出现时发生 IPv4/IPv6 转发竞态，启动脚本会复用
Colima 已有的 SSH ControlMaster 补建同一条 loopback 转发；其他 Docker context 不执行
任何 SSH 操作。

当前 LocalStack 镜像必须使用 Auth Token 激活。免费 Hobby 方案无需 AWS 账号或信用卡；
在 <https://app.localstack.cloud/sign-up?plan=free> 注册并生成 token 后，写入专用的 Git
忽略文件，不得发到聊天或提交仓库：

```bash
cp .env.localstack.example .env.localstack.local
# 编辑 .env.localstack.local，填写 LOCALSTACK_AUTH_TOKEN
```

脚本会自动读取该文件；临时运行也可在 shell 中显式设置同名变量覆盖本机默认值。

```bash
# 只启动或恢复 LocalStack 容器，不创建项目资源
pnpm localstack:start

# 启动容器并创建本地 KMS key、Secret、FIFO 队列/DLQ、验收队列和 SNS topic
pnpm localstack:bootstrap

# 构建 Hono Lambda，通过 cdklocal 部署同一份 CDK stack
pnpm localstack:deploy

# 实际验证 KMS、Secret、SQS、SNS、CloudFormation、EventBridge 和 Lambda /api/health
pnpm localstack:verify

# 查看容器、Edge 端点和本地资源清单状态
pnpm localstack:status

# 只停止容器，保留容器层以便下次快速启动
pnpm localstack:stop
```

资源清单写入未跟踪的 `.local/localstack/resources.json`，不包含 Auth Token 或 Secret 原文。
Lambda 从容器内通过 `host.docker.internal` 访问本机 PostgreSQL、Dispatch Engine
和 Anvil。宿主机 CDK 使用 `http://127.0.0.1:4566`，Lambda 运行时使用
`http://host.docker.internal:4566`；真实 AWS 部署不注入兼容端点，保持 SDK 的 region
端点解析。`aws-cdk-local` 的 S3 资产上传也使用 IP endpoint，强制 AWS SDK 采用
path-style；这可避免 `<bucket>.s3.*` 多级子域被系统代理 DNS 映射到 `198.18/15`
测试网段。

## 打包方案说明

`infra/build-lambda.sh` 先重新生成 87 条 Hono 静态路由索引，再用 esbuild 把
`src/lambda.ts` 及运行依赖打进 CommonJS `infra/.dist/lambda/index.js`。CDK 使用
`index.handler`，不启动常驻 HTTP server，也不需要 React、Next.js standalone、静态资源
复制或 Lambda Web Adapter Layer。最终制品使用 CommonJS 是为了让 SIWE 的 `apg-js`
依赖继续使用 Node 原生动态 `require("buffer")`；业务源码仍保持 TypeScript ESM。本地开发
入口 `src/server.ts` 与 Lambda 入口复用同一个 `app.fetch`，避免两种部署形态维护不同路由。

## 已验证 / 未验证

- ✅ Hono 路由表完整挂载 87 个路由模块，`app.request('/api/health')` 返回 200；本地 Node
  bundle 和 `infra/.dist/lambda/index.js` Lambda bundle 均已构建通过。
- ✅ `cdk synth` 产出的 CloudFormation 模板经人工检查，`Outputs.MarketplaceApiFunctionUrl`
  正确引用 `AWS::Lambda::Url` 资源的 `FunctionUrl` 属性（CDK 高层构造自动处理，
  不是手写 `Fn::GetAtt` 拼错属性名）。
- ✅ 环境变量缺失时 `cdk synth` 按预期直接报错，不会用空值悄悄部署。
- ✅ LocalStack 已完成真实本机部署与运行验收：KMS 数据密钥、Secret 版本更新、SQS
  FIFO 收发删除、SNS 发布、SSM/CDK bootstrap、S3 资产上传、CloudFormation 栈、
  EventBridge Rule/Connection/API Destination 和 Lambda `/api/health` 全部通过。
- ❌ **未在真实 AWS 账号执行过 `cdk deploy`**：Lambda 冷启动、Function URL 的真实
  可达性、连接真实 PostgreSQL/KMS 均未验证。
- ❌ 未做真实浏览器的跨源请求验证（CORS 预检、`credentials:"include"` 的完整链路）。

这些未验证项需要具备 AWS 账号权限的人工执行一次 `cdk bootstrap` + `cdk deploy` 才能
确认，属于本 task 范围之外的环境级验证（与项目 `.claude/rules/testing.md` 的既有原则
一致：本地/单元验证不能代替真实环境验证）。
