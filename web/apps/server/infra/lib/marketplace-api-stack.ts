/**
 * `web/apps/server` 的 AWS Lambda 部署栈（2.agent-registration T-009）。
 *
 * 承载方案：Hono AWS Lambda Adapter + esbuild 单文件制品。Hono 把 API Gateway v2/
 * Function URL 事件转换成标准 Request/Response，业务路由与领域逻辑不感知 Lambda。
 *
 * 用户 2026-08-22 确认：IaC 工具选 CDK 而不是 SAM——理由是这个项目已知会有多个
 * Lambda（本函数 + 未来 feature 9/10 的 SQS 消费者、feature 12 的定时评分任务），
 * CDK 用真正的编程语言表达共享配置，比 SAM 的 YAML 模板更适合这个规模；本决定与
 * Hono Adapter 的运行边界无关，切换 IaC 工具不影响业务路由。
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CfnOutput,
	Duration,
	SecretValue,
	Stack,
	type StackProps,
} from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import type { Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 运行时必需的环境变量：从部署者本机的 shell 环境变量读取（`DATABASE_URL=... pnpm
 * infra:deploy` 这样调用），不硬编码到代码或提交进仓库。缺失时在 synth 阶段直接
 * 报错，而不是部署出一个环境变量为空、运行时才报错的 Lambda。
 *
 * 没有用 CDK `--context`：`infra:deploy`/`infra:synth` 是 `pnpm infra:build-lambda
 * && cd infra && pnpm exec cdk ...` 这样的复合 npm script，`pnpm run <script> --
 * --context k=v` 传参无法正确穿透到复合命令里的最后一条子命令（已实测复现，
 * `--context` 参数会丢失，`requireContext` 仍然报缺失）；环境变量前缀天然对复合
 * shell 命令生效，不受这个限制。
 */
const COMMON_REQUIRED_ENV_KEYS = [
	"DATABASE_URL",
	"AGENT_CREDENTIALS_KMS_KEY_ID",
	"SIWE_EXPECTED_DOMAIN",
	"SIWE_EXPECTED_URI",
	"SIWE_EXPECTED_CHAIN_ID",
	"DISPATCH_ENGINE_URL",
	"ETHEREUM_RPC_URL",
	"ESCROW_CHAIN_ID",
	"ESCROW_CONTRACT_ADDRESS",
	"ESCROW_PAYMENT_TOKEN_ADDRESS",
	"ESCROW_START_BLOCK",
	"ESCROW_REQUIRED_CONFIRMATIONS",
] as const;

export interface MarketplaceApiStackProps extends StackProps {
	/** AWS 使用真实 Secret 动态引用；LocalStack 只注入固定的本地测试 token。 */
	deploymentTarget?: "aws" | "localstack";
}

function requireEnv(key: string): string {
	const value = process.env[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			`缺少必需的环境变量 "${key}"：部署前必须通过 ${key}=<value> 提供（如 "${key}=... pnpm infra:deploy"），参见 infra/README.md`,
		);
	}
	return value;
}

export class MarketplaceApiStack extends Stack {
	constructor(scope: Construct, id: string, props?: MarketplaceApiStackProps) {
		super(scope, id, props);
		const deploymentTarget = props?.deploymentTarget ?? "aws";
		const internalTokenSecret =
			deploymentTarget === "localstack"
				? SecretValue.unsafePlainText(requireEnv("DISPATCH_INTERNAL_TOKEN"))
				: SecretValue.secretsManager(
						requireEnv("DISPATCH_INTERNAL_TOKEN_SECRET_ARN"),
					);

		const runtimeEnv: Record<string, string> = {
			DATABASE_URL: requireEnv("DATABASE_URL"),
			AGENT_CREDENTIALS_KMS_KEY_ID: requireEnv("AGENT_CREDENTIALS_KMS_KEY_ID"),
			SIWE_EXPECTED_DOMAIN: requireEnv("SIWE_EXPECTED_DOMAIN"),
			SIWE_EXPECTED_URI: requireEnv("SIWE_EXPECTED_URI"),
			SIWE_EXPECTED_CHAIN_ID: requireEnv("SIWE_EXPECTED_CHAIN_ID"),
			DISPATCH_ENGINE_URL: requireEnv("DISPATCH_ENGINE_URL"),
			...(process.env.LOCALSTACK_LAMBDA_AWS_ENDPOINT_URL !== undefined && {
				// CDK 在宿主机访问 127.0.0.1，而 Lambda 在 Docker 网络中必须通过
				// host.docker.internal 回到 LocalStack；两个地址不能共用一个变量。
				AWS_ENDPOINT_URL: process.env.LOCALSTACK_LAMBDA_AWS_ENDPOINT_URL,
			}),
			// Escrow 与 USDC 地址必须来自同一份网络部署产物。把两者都设为部署必填，
			// 避免 Lambda 连接正确链却把交易编码给另一网络的 Token 或合约。
			ETHEREUM_RPC_URL: requireEnv("ETHEREUM_RPC_URL"),
			ESCROW_CHAIN_ID: requireEnv("ESCROW_CHAIN_ID"),
			ESCROW_CONTRACT_ADDRESS: requireEnv("ESCROW_CONTRACT_ADDRESS"),
			ESCROW_PAYMENT_TOKEN_ADDRESS: requireEnv("ESCROW_PAYMENT_TOKEN_ADDRESS"),
			ESCROW_START_BLOCK: requireEnv("ESCROW_START_BLOCK"),
			ESCROW_REQUIRED_CONFIRMATIONS: requireEnv(
				"ESCROW_REQUIRED_CONFIRMATIONS",
			),
			// CloudFormation 在部署时解析 Secrets Manager 动态引用；真实 token 不进入
			// synth 模板或 cdk.out。应用运行时仍读取同一个 DISPATCH_INTERNAL_TOKEN 名称。
			DISPATCH_INTERNAL_TOKEN: internalTokenSecret.unsafeUnwrap(),
		};

		const fn = new lambda.Function(this, "MarketplaceApiFunction", {
			runtime: lambda.Runtime.NODEJS_22_X,
			architecture: lambda.Architecture.X86_64,
			handler: "index.handler",
			// infra/build-lambda.sh 的产物目录；部署前必须先跑一遍该脚本
			// （package.json 的 infra:deploy / infra:synth script 已经串联好顺序）。
			code: lambda.Code.fromAsset(path.join(__dirname, "../.dist/lambda")),
			memorySize: 512,
			timeout: Duration.seconds(15),
			environment: runtimeEnv,
		});

		// AuthType.NONE 是必要的，不是遗漏：web/apps/web 与本服务是跨源部署，前端
		// 需要直接从浏览器发起请求，认证由应用层 SIWE session（httpOnly cookie）
		// 负责，不依赖 Lambda 层的 IAM 鉴权。CORS 响应头由 src/http/cors.ts 的
		// withCredentialedCors/handleCorsPreflight 统一处理（单一权威位置），这里
		// 不重复配置 Function URL 自带的 CORS，避免出现两套 CORS 头相互覆盖。
		const fnUrl = fn.addFunctionUrl({
			authType: lambda.FunctionUrlAuthType.NONE,
		});

		/**
		 * Feature 12 的评分读路径只查快照，重计算必须由生产调度主动触发。这里使用
		 * EventBridge API Destination 调用既有内部 HTTP 契约，而不是再创建一个只会
		 * 转发到同一服务的 Lambda。Authorization 值存入 EventBridge Connection 管理的
		 * secret，不放进 Rule Input 或日志事件；内部 Route Handler 仍会做常量时间校验。
		 *
		 * 每小时选择 100 个“从未计算或最久未更新”的 Agent。仓储层按快照时间轮转，
		 * 因此 Agent 数超过单批上限时不会永久饿死；单轮失败由 EventBridge 重试，下一
		 * 个小时也会优先补算仍然最旧的批次。
		 */
		const scoringConnection = new events.Connection(
			this,
			"ScoreSnapshotConnection",
			{
				description: "调用 Marketplace API 内部评分快照 worker 的 Bearer 凭据",
				authorization: events.Authorization.apiKey(
					"Authorization",
					// unsafePlainText 包裹的是动态引用而非凭据原文，用于在 Bearer 前缀后嵌入
					// 同一个 secret；CloudFormation 部署时才解析真正的 token。
					SecretValue.unsafePlainText(
						`Bearer ${internalTokenSecret.unsafeUnwrap()}`,
					),
				),
			},
		);
		const scoringDestination = new events.ApiDestination(
			this,
			"ScoreSnapshotDestination",
			{
				// 显式物理名称同时提升运维可读性，并满足 LocalStack EventBridge provider
				// 对 CreateApiDestination.Name 的严格校验；真实 AWS 也接受同一契约。
				apiDestinationName: "aicp-score-snapshot",
				connection: scoringConnection,
				endpoint: `${fnUrl.url}api/internal/workers/score-snapshots`,
				httpMethod: events.HttpMethod.POST,
				rateLimitPerSecond: 1,
			},
		);
		const scoringRule = new events.Rule(this, "ScoreSnapshotSchedule", {
			description: "每小时刷新最旧的一批 Agent 评分",
			schedule: events.Schedule.rate(Duration.hours(1)),
		});
		// aws-cdk-lib 2.266 在 exactOptionalPropertyTypes 下把新建资源的 policy ARN 声明
		// 为可选，但 targets.ApiDestination 的接口又要求必填。先做运行时不变量检查，再
		// 通过官方 import API 收窄类型；不要用 as 断言跳过这个真实的 IAM 前置条件。
		const scoringDestinationPolicyArn =
			scoringDestination.apiDestinationArnForPolicy;
		if (scoringDestinationPolicyArn === undefined) {
			throw new Error("新建的评分快照 API Destination 缺少 IAM policy ARN");
		}
		const scoringTargetDestination =
			events.ApiDestination.fromApiDestinationAttributes(
				this,
				"ScoreSnapshotDestinationTarget",
				{
					apiDestinationArn: scoringDestination.apiDestinationArn,
					apiDestinationArnForPolicy: scoringDestinationPolicyArn,
					connection: scoringConnection,
				},
			);
		scoringRule.addTarget(
			new targets.ApiDestination(scoringTargetDestination, {
				event: events.RuleTargetInput.fromObject({ limit: 100 }),
				maxEventAge: Duration.hours(2),
				retryAttempts: 3,
			}),
		);

		new CfnOutput(this, "MarketplaceApiFunctionUrl", {
			value: fnUrl.url,
			description:
				"web/apps/server 的 Lambda Function URL（web/apps/web 的 NEXT_PUBLIC_MARKETPLACE_API_URL 指向这里）",
		});
		new CfnOutput(this, "MarketplaceApiFunctionName", {
			value: fn.functionName,
			description: "供 LocalStack 验收脚本执行 Lambda invoke 的物理函数名",
		});
	}
}

// 供测试/文档引用，避免魔法字符串散落多处。
export { COMMON_REQUIRED_ENV_KEYS };
