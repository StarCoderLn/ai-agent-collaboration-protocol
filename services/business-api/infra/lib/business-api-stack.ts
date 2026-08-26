/**
 * `services/business-api` 的 AWS Lambda 部署栈（2.agent-registration T-009）。
 *
 * 承载方案：AWS Lambda Web Adapter（LWA）+ zip 打包（不用容器镜像，见
 * infra/build-lambda.sh 顶部注释）——把 Next.js `output: "standalone"` 产出的标准
 * Node HTTP server 原样跑在 Lambda 里，业务路由本身（app/api/**）完全不感知
 * Lambda 运行时的存在，路由挂载与业务逻辑跟"部署到哪、用什么工具部署"解耦。
 *
 * 用户 2026-08-22 确认：IaC 工具选 CDK 而不是 SAM——理由是这个项目已知会有多个
 * Lambda（本函数 + 未来 feature 9/10 的 SQS 消费者、feature 12 的定时评分任务），
 * CDK 用真正的编程语言表达共享配置，比 SAM 的 YAML 模板更适合这个规模；本决定与
 * "zip 打包 + LWA Layer"这条部署方案本身无关，切换 IaC 工具不影响打包方式。
 */
import { Stack, type StackProps, Duration, CfnOutput, SecretValue } from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * AWS 官方发布的 Lambda Web Adapter Layer 版本号（x86_64，AWS 商业分区）。
 * 账号 ID `753240598075` 是 AWS 官方发布账号，各区域固定，只有版本号会随发布更新。
 * 来源：https://github.com/aws/aws-lambda-web-adapter/blob/main/examples/nextjs-zip/template.yaml
 * 升级前需要确认新版本号（该仓库 Releases 页面），不要盲目改大。
 */
const LWA_LAYER_VERSION = 28;

/** Lambda 部署包内 Next.js server.js 监听的端口，LWA 通过同一个 `PORT` 变量得知转发目标。 */
const APP_PORT = "8000";

/**
 * 运行时必需的环境变量：从部署者本机的 shell 环境变量读取（`DATABASE_URL=... pnpm
 * infra:deploy` 这样调用），不硬编码到代码或提交进仓库。缺失时在 synth 阶段直接
 * 报错，而不是部署出一个环境变量为空、运行时才报错的 Lambda。
 *
 * 没有用 CDK `--context`：`infra:deploy`/`infra:synth` 是 `pnpm infra:build-lambda
 * && cd infra && npx cdk ...` 这样的复合 npm script，`pnpm run <script> --
 * --context k=v` 传参无法正确穿透到复合命令里的最后一条子命令（已实测复现，
 * `--context` 参数会丢失，`requireContext` 仍然报缺失）；环境变量前缀天然对复合
 * shell 命令生效，不受这个限制。
 */
const REQUIRED_ENV_KEYS = [
	"DATABASE_URL",
	"AGENT_CREDENTIALS_KMS_KEY_ID",
	"SIWE_EXPECTED_DOMAIN",
	"SIWE_EXPECTED_URI",
	"SIWE_EXPECTED_CHAIN_ID",
	"DISPATCH_ENGINE_URL",
	"DISPATCH_INTERNAL_TOKEN_SECRET_ARN",
] as const;

function requireEnv(key: string): string {
	const value = process.env[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			`缺少必需的环境变量 "${key}"：部署前必须通过 ${key}=<value> 提供（如 "${key}=... pnpm infra:deploy"），参见 infra/README.md`,
		);
	}
	return value;
}

export class BusinessApiStack extends Stack {
	constructor(scope: Construct, id: string, props?: StackProps) {
		super(scope, id, props);
		const internalTokenSecret = SecretValue.secretsManager(requireEnv("DISPATCH_INTERNAL_TOKEN_SECRET_ARN"));

		const runtimeEnv: Record<string, string> = {
			AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
			AWS_LWA_ENABLE_COMPRESSION: "true",
			PORT: APP_PORT,
			DATABASE_URL: requireEnv("DATABASE_URL"),
			AGENT_CREDENTIALS_KMS_KEY_ID: requireEnv("AGENT_CREDENTIALS_KMS_KEY_ID"),
			SIWE_EXPECTED_DOMAIN: requireEnv("SIWE_EXPECTED_DOMAIN"),
			SIWE_EXPECTED_URI: requireEnv("SIWE_EXPECTED_URI"),
			SIWE_EXPECTED_CHAIN_ID: requireEnv("SIWE_EXPECTED_CHAIN_ID"),
			DISPATCH_ENGINE_URL: requireEnv("DISPATCH_ENGINE_URL"),
			// CloudFormation 在部署时解析 Secrets Manager 动态引用；真实 token 不进入
			// synth 模板或 cdk.out。应用运行时仍读取同一个 DISPATCH_INTERNAL_TOKEN 名称。
			DISPATCH_INTERNAL_TOKEN: internalTokenSecret.unsafeUnwrap(),
		};

		const adapterLayer = lambda.LayerVersion.fromLayerVersionArn(
			this,
			"LambdaWebAdapterLayer",
			`arn:aws:lambda:${this.region}:753240598075:layer:LambdaAdapterLayerX86:${LWA_LAYER_VERSION}`,
		);

		const fn = new lambda.Function(this, "BusinessApiFunction", {
			runtime: lambda.Runtime.NODEJS_22_X,
			architecture: lambda.Architecture.X86_64,
			handler: "run.sh",
			// infra/build-lambda.sh 的产物目录；部署前必须先跑一遍该脚本
			// （package.json 的 infra:deploy / infra:synth script 已经串联好顺序）。
			code: lambda.Code.fromAsset(path.join(__dirname, "../.dist/lambda")),
			memorySize: 512,
			timeout: Duration.seconds(15),
			layers: [adapterLayer],
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
		const scoringConnection = new events.Connection(this, "ScoreSnapshotConnection", {
			description: "调用 Business API 内部评分快照 worker 的 Bearer 凭据",
			authorization: events.Authorization.apiKey(
				"Authorization",
				// unsafePlainText 包裹的是动态引用而非凭据原文，用于在 Bearer 前缀后嵌入
				// 同一个 secret；CloudFormation 部署时才解析真正的 token。
				SecretValue.unsafePlainText(`Bearer ${internalTokenSecret.unsafeUnwrap()}`),
			),
		});
		const scoringDestination = new events.ApiDestination(this, "ScoreSnapshotDestination", {
			connection: scoringConnection,
			endpoint: `${fnUrl.url}api/internal/workers/score-snapshots`,
			httpMethod: events.HttpMethod.POST,
			rateLimitPerSecond: 1,
		});
		const scoringRule = new events.Rule(this, "ScoreSnapshotSchedule", {
			description: "每小时刷新最旧的一批 Agent 评分",
			schedule: events.Schedule.rate(Duration.hours(1)),
		});
		// aws-cdk-lib 2.266 在 exactOptionalPropertyTypes 下把新建资源的 policy ARN 声明
		// 为可选，但 targets.ApiDestination 的接口又要求必填。先做运行时不变量检查，再
		// 通过官方 import API 收窄类型；不要用 as 断言跳过这个真实的 IAM 前置条件。
		const scoringDestinationPolicyArn = scoringDestination.apiDestinationArnForPolicy;
		if (scoringDestinationPolicyArn === undefined) {
			throw new Error("新建的评分快照 API Destination 缺少 IAM policy ARN");
		}
		const scoringTargetDestination = events.ApiDestination.fromApiDestinationAttributes(
			this,
			"ScoreSnapshotDestinationTarget",
			{
				apiDestinationArn: scoringDestination.apiDestinationArn,
				apiDestinationArnForPolicy: scoringDestinationPolicyArn,
				connection: scoringConnection,
			},
		);
		scoringRule.addTarget(new targets.ApiDestination(scoringTargetDestination, {
			event: events.RuleTargetInput.fromObject({ limit: 100 }),
			maxEventAge: Duration.hours(2),
			retryAttempts: 3,
		}));

		new CfnOutput(this, "BusinessApiFunctionUrl", {
			value: fnUrl.url,
			description: "services/business-api 的 Lambda Function URL（web/apps/web 的 NEXT_PUBLIC_BUSINESS_API_URL 指向这里）",
		});
	}
}

// 供测试/文档引用，避免魔法字符串散落多处。
export { REQUIRED_ENV_KEYS };
