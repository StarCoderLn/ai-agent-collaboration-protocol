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
import { Stack, type StackProps, Duration, CfnOutput } from "aws-cdk-lib";
import type { Construct } from "constructs";
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

		const runtimeEnv: Record<string, string> = {
			AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
			AWS_LWA_ENABLE_COMPRESSION: "true",
			PORT: APP_PORT,
			DATABASE_URL: requireEnv("DATABASE_URL"),
			AGENT_CREDENTIALS_KMS_KEY_ID: requireEnv("AGENT_CREDENTIALS_KMS_KEY_ID"),
			SIWE_EXPECTED_DOMAIN: requireEnv("SIWE_EXPECTED_DOMAIN"),
			SIWE_EXPECTED_URI: requireEnv("SIWE_EXPECTED_URI"),
			SIWE_EXPECTED_CHAIN_ID: requireEnv("SIWE_EXPECTED_CHAIN_ID"),
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

		new CfnOutput(this, "BusinessApiFunctionUrl", {
			value: fnUrl.url,
			description: "services/business-api 的 Lambda Function URL（web/apps/web 的 NEXT_PUBLIC_BUSINESS_API_URL 指向这里）",
		});
	}
}

// 供测试/文档引用，避免魔法字符串散落多处。
export { REQUIRED_ENV_KEYS };
