/**
 * Marketplace API 的 LocalStack 生命周期与验收入口。
 *
 * 本机没有 Docker Compose 插件，因此这里直接调用 Docker CLI；所有子进程都使用参数数组，
 * 不经过 shell 拼接。脚本不会挂载持久卷，LocalStack 状态只保存在单个容器层中，避免开发
 * 环境长期积累难以察觉的大体积缓存。停止后可再次启动；若停止容器的许可证凭据已变化，
 * 脚本只重建自己管理的 `aicp-localstack` 容器，不删除镜像、卷或其他容器。
 */

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const appDirectory = path.resolve(scriptDirectory, "..");
const repositoryRoot = path.resolve(appDirectory, "../../..");
const stateDirectory = path.join(repositoryRoot, ".local", "localstack");
const manifestPath = path.join(stateDirectory, "resources.json");
const lambdaResponsePath = path.join(stateDirectory, "lambda-response.json");
const localEnvironmentPath = path.join(appDirectory, ".env.localstack.local");

/**
 * LocalStack 的许可证 token 需要跨终端持久可用，但不能进入仓库或通用应用环境。Node 22
 * 原生读取专用的 Git 忽略文件；调用者显式传入的环境变量仍可覆盖本机默认配置。
 */
try {
	process.loadEnvFile(localEnvironmentPath);
} catch (error) {
	if (
		typeof error !== "object" ||
		error === null ||
		!("code" in error) ||
		error.code !== "ENOENT"
	) {
		throw error;
	}
}

const containerName = "aicp-localstack";
const image = process.env.LOCALSTACK_IMAGE ?? "localstack/localstack:2026.08.2";

/**
 * 此入口只允许连接本机兼容端点。即使开发者的 shell 中残留真实 AWS 配置，也不能让
 * bootstrap/deploy/verify 误指向公网服务；真实 AWS 部署继续使用独立的 infra 命令。
 */
function localEndpoint(rawEndpoint) {
	let parsed;
	try {
		parsed = new URL(rawEndpoint);
	} catch {
		throw new Error("AWS_ENDPOINT_URL 必须是本机绝对 HTTP(S) URL");
	}
	if (
		parsed.protocol !== "http:" ||
		(parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
		parsed.port !== "4566" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		(parsed.pathname !== "" && parsed.pathname !== "/") ||
		parsed.search !== "" ||
		parsed.hash !== ""
	) {
		throw new Error(
			"AWS_ENDPOINT_URL 只允许无凭据、无路径的 http://localhost:4566 或 http://127.0.0.1:4566",
		);
	}
	return parsed.origin;
}

const endpoint = localEndpoint(
	process.env.AWS_ENDPOINT_URL ?? "http://127.0.0.1:4566",
);
const lambdaEndpoint =
	process.env.LOCALSTACK_LAMBDA_AWS_ENDPOINT_URL ??
	"http://host.docker.internal:4566";
const region = process.env.AWS_REGION ?? "us-east-1";
const accountId = "000000000000";
const internalToken =
	process.env.DISPATCH_INTERNAL_TOKEN ??
	"localstack-dispatch-token-32-characters";
const keyAlias = "alias/aicp-agent-credentials";
const secretName = "aicp/local/dispatch-internal-token";
const queueName = "aicp-dispatch.fifo";
const deadLetterQueueName = "aicp-dispatch-dlq.fifo";
const verificationQueueName = "aicp-localstack-smoke.fifo";
const topicName = "aicp-task-events";
const enabledServices =
	"cloudformation,events,iam,kms,lambda,logs,s3,secretsmanager,sns,sqs,ssm,sts";

const awsEnvironment = {
	...process.env,
	// LocalStack 固定使用测试凭据，不继承开发者 shell 中可能存在的真实 AWS access key。
	AWS_ACCESS_KEY_ID: "test",
	AWS_SECRET_ACCESS_KEY: "test",
	AWS_SESSION_TOKEN: "",
	AWS_EC2_METADATA_DISABLED: "true",
	AWS_DEFAULT_REGION: region,
	AWS_REGION: region,
	AWS_PAGER: "",
};

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		env: options.env ?? process.env,
		encoding: "utf8",
		stdio: options.capture ? "pipe" : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0 && !options.allowFailure) {
		const detail = options.capture ? result.stderr.trim() : "";
		throw new Error(
			`${command} 执行失败（exit=${result.status ?? "unknown"}）${detail ? `：${detail}` : ""}`,
		);
	}
	return result;
}

function aws(args, options = {}) {
	return run("aws", ["--endpoint-url", endpoint, ...args], {
		...options,
		env: awsEnvironment,
	});
}

function containerState() {
	const result = run(
		"docker",
		["inspect", "--format", "{{.State.Running}}", containerName],
		{ capture: true, allowFailure: true },
	);
	if (result.status !== 0) {
		const detail = result.stderr.trim();
		if (/No such (object|container)/i.test(detail)) return "missing";
		throw new Error(
			`无法检查 LocalStack 容器状态${detail ? `：${detail}` : ""}`,
		);
	}
	return result.stdout.trim() === "true" ? "running" : "stopped";
}

/**
 * 2026 版 LocalStack 镜像启动时必须在线激活许可证。凭据只从进程环境读取，并通过
 * Docker 的“仅变量名”形式继承，既不出现在命令参数中，也不会写入资源清单。
 */
function requireAuthToken() {
	const token = process.env.LOCALSTACK_AUTH_TOKEN?.trim();
	if (!token) {
		throw new Error(
			"缺少 LOCALSTACK_AUTH_TOKEN：请在 LocalStack 免费 Hobby 账号中生成 Auth Token，并写入 .env.localstack.local 或本机环境变量",
		);
	}
	return token;
}

/**
 * Docker 无法修改既有容器的环境变量。只有脚本管理的停止容器确实使用了当前 token，
 * 才能直接重启；否则重建这个无持久卷容器，避免反复启动一个必然激活失败的旧实例。
 */
function containerEnvironment() {
	const result = run(
		"docker",
		["inspect", "--format", "{{json .Config.Env}}", containerName],
		{ capture: true, allowFailure: true },
	);
	if (result.status !== 0) return undefined;
	try {
		const environment = JSON.parse(result.stdout);
		return Array.isArray(environment) ? environment : undefined;
	} catch {
		return undefined;
	}
}

function containerUsesAuthToken(token, environment) {
	return environment?.includes(`LOCALSTACK_AUTH_TOKEN=${token}`) ?? false;
}

function containerUsesExpectedServices(environment) {
	return environment?.includes(`SERVICES=${enabledServices}`) ?? false;
}

/**
 * Colima 的 SSH port forwarder 只能稳定转发 VM 内的 loopback 监听。若 Docker 绑定
 * `0.0.0.0/[::]`，hostagent 会生成失败的转发命令，表现为容器健康但 macOS 无法访问
 * 4566。这里把正确绑定作为容器可复用条件，而不是在宿主机额外常驻一个临时隧道。
 */
function containerUsesLoopbackPort() {
	const result = run(
		"docker",
		[
			"inspect",
			"--format",
			'{{json (index .HostConfig.PortBindings "4566/tcp")}}',
			containerName,
		],
		{ capture: true, allowFailure: true },
	);
	if (result.status !== 0) return false;
	try {
		const bindings = JSON.parse(result.stdout);
		return (
			Array.isArray(bindings) &&
			bindings.length === 1 &&
			bindings[0]?.HostIp === "127.0.0.1" &&
			bindings[0]?.HostPort === "4566"
		);
	} catch {
		return false;
	}
}

function createContainer() {
	run("docker", [
		"run",
		"--detach",
		"--name",
		containerName,
		"--publish",
		"127.0.0.1:4566:4566",
		"--label",
		"com.aicp.localstack.managed=true",
		"--env",
		"LOCALSTACK_AUTH_TOKEN",
		"--env",
		`SERVICES=${enabledServices}`,
		"--env",
		"DEBUG=0",
		"--volume",
		"/var/run/docker.sock:/var/run/docker.sock",
		image,
	]);
}

async function endpointIsReady(timeout = 1_000) {
	try {
		const response = await fetch(`${endpoint}/_localstack/health`, {
			signal: AbortSignal.timeout(timeout),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/**
 * Colima 0.10 的 SSH hostagent 偶尔会在 Docker 同时报告 IPv4/IPv6 监听时发生竞态，
 * 自动转发命令返回 255。这里不启动第二套常驻代理，而是复用 Colima 已有的 SSH
 * ControlMaster 补建同一条 loopback 转发；其他 Docker context 完全不受影响。
 */
async function ensureColimaPortForward() {
	if (await endpointIsReady()) return;
	const contextResult = run("docker", ["context", "show"], {
		capture: true,
		allowFailure: true,
	});
	const context = contextResult.stdout.trim();
	if (!/^colima(?:-[A-Za-z0-9._-]+)?$/.test(context)) return;

	const colimaHome =
		process.env.COLIMA_HOME?.trim() || path.join(homedir(), ".colima");
	const sshConfig = path.join(colimaHome, "_lima", context, "ssh.config");
	run(
		"ssh",
		[
			"-F",
			sshConfig,
			"-O",
			"forward",
			"-L",
			"127.0.0.1:4566:127.0.0.1:4566",
			`lima-${context}`,
		],
		{ capture: true, allowFailure: true },
	);
}

async function waitUntilReady() {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		if (await endpointIsReady()) return;
		if (attempt > 0 && containerState() !== "running") {
			throw new Error(
				`LocalStack 容器在启动完成前退出；请执行 docker logs ${containerName} 检查许可证或运行时错误`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	throw new Error("LocalStack 在 60 秒内未进入可用状态");
}

async function start() {
	const authToken = requireAuthToken();
	const state = containerState();
	const environment = state === "missing" ? undefined : containerEnvironment();
	const reusable =
		state !== "missing" &&
		containerUsesAuthToken(authToken, environment) &&
		containerUsesExpectedServices(environment) &&
		containerUsesLoopbackPort();
	if (state === "running" && !reusable) {
		// Docker 不支持就地修改环境变量或端口绑定，只重建本脚本的固定名称容器。
		run("docker", ["stop", containerName]);
		run("docker", ["rm", containerName]);
		createContainer();
	} else if (state === "stopped") {
		if (reusable) {
			run("docker", ["start", containerName]);
		} else {
			// 仅删除本脚本创建且当前已停止的无持久卷容器，不触碰镜像、卷或其他服务。
			run("docker", ["rm", containerName]);
			createContainer();
		}
	} else if (state === "missing") {
		createContainer();
	}
	await ensureColimaPortForward();
	await waitUntilReady();
	process.stdout.write(`LocalStack 已就绪：${endpoint}\n`);
}

function outputOfAws(args) {
	return aws(args, { capture: true }).stdout.trim();
}

function stackPhysicalResourceId(resourceType) {
	const physicalId = outputOfAws([
		"cloudformation",
		"list-stack-resources",
		"--stack-name",
		"MarketplaceApiStack",
		"--query",
		`StackResourceSummaries[?ResourceType=='${resourceType}'].PhysicalResourceId | [0]`,
		"--output",
		"text",
	]);
	if (physicalId.length === 0 || physicalId === "None") {
		throw new Error(`MarketplaceApiStack 缺少 ${resourceType} 资源`);
	}
	return physicalId;
}

function ensureKey() {
	const existing = aws(["kms", "describe-key", "--key-id", keyAlias], {
		capture: true,
		allowFailure: true,
	});
	if (existing.status === 0) return;
	const keyId = outputOfAws([
		"kms",
		"create-key",
		"--description",
		"AICP LocalStack Agent credential envelope key",
		"--query",
		"KeyMetadata.KeyId",
		"--output",
		"text",
	]);
	aws([
		"kms",
		"create-alias",
		"--alias-name",
		keyAlias,
		"--target-key-id",
		keyId,
	]);
}

function ensureSecret() {
	const existing = aws(
		["secretsmanager", "describe-secret", "--secret-id", secretName],
		{ capture: true, allowFailure: true },
	);
	if (existing.status !== 0) {
		aws(
			[
				"secretsmanager",
				"create-secret",
				"--name",
				secretName,
				"--secret-string",
				internalToken,
			],
			{ capture: true },
		);
	} else {
		// bootstrap 可重复执行；本机 token 变化后同步新版本，避免清单存在但验收失败。
		aws(
			[
				"secretsmanager",
				"put-secret-value",
				"--secret-id",
				secretName,
				"--secret-string",
				internalToken,
			],
			{ capture: true },
		);
	}
	return outputOfAws([
		"secretsmanager",
		"describe-secret",
		"--secret-id",
		secretName,
		"--query",
		"ARN",
		"--output",
		"text",
	]);
}

function ensureQueue(name, attributes) {
	const existing = aws(["sqs", "get-queue-url", "--queue-name", name], {
		capture: true,
		allowFailure: true,
	});
	if (existing.status === 0) {
		return JSON.parse(existing.stdout).QueueUrl;
	}
	return outputOfAws([
		"sqs",
		"create-queue",
		"--queue-name",
		name,
		"--attributes",
		JSON.stringify(attributes),
		"--query",
		"QueueUrl",
		"--output",
		"text",
	]);
}

async function bootstrap() {
	await start();
	ensureKey();
	const secretArn = ensureSecret();
	const deadLetterQueueUrl = ensureQueue(deadLetterQueueName, {
		FifoQueue: "true",
	});
	const deadLetterQueueArn = outputOfAws([
		"sqs",
		"get-queue-attributes",
		"--queue-url",
		deadLetterQueueUrl,
		"--attribute-names",
		"QueueArn",
		"--query",
		"Attributes.QueueArn",
		"--output",
		"text",
	]);
	const queueUrl = ensureQueue(queueName, {
		FifoQueue: "true",
		ContentBasedDeduplication: "false",
		VisibilityTimeout: "30",
		RedrivePolicy: JSON.stringify({
			deadLetterTargetArn: deadLetterQueueArn,
			maxReceiveCount: "5",
		}),
	});
	const verificationQueueUrl = ensureQueue(verificationQueueName, {
		FifoQueue: "true",
		ContentBasedDeduplication: "false",
		VisibilityTimeout: "10",
	});
	const topicArn = outputOfAws([
		"sns",
		"create-topic",
		"--name",
		topicName,
		"--query",
		"TopicArn",
		"--output",
		"text",
	]);

	await mkdir(stateDirectory, { recursive: true });
	await writeFile(
		manifestPath,
		`${JSON.stringify({ endpoint, region, accountId, keyAlias, secretArn, queueUrl, deadLetterQueueUrl, verificationQueueUrl, topicArn }, null, 2)}\n`,
		"utf8",
	);
	process.stdout.write(`LocalStack 资源已就绪，清单：${manifestPath}\n`);
	return { secretArn, queueUrl, verificationQueueUrl, topicArn };
}

function deploymentEnvironment(resources) {
	return {
		...awsEnvironment,
		AICP_AWS_TARGET: "localstack",
		// cdklocal 在宿主机执行，必须使用宿主机可达地址。
		AWS_ENDPOINT_URL: endpoint,
		// aws-cdk-local 3.x 要求资产上传使用独立 S3 端点。IP endpoint 会让 AWS SDK
		// 采用 path-style，避免 CDK 生成 `<bucket>.s3.*` 多级子域后被本机代理 DNS
		// 映射到 198.18/15；同一地址已通过真实 PutObject 验证。
		AWS_ENDPOINT_URL_S3: endpoint,
		// CDK 只把此地址注入 Lambda 运行时，不让宿主机 CLI 错用 Docker 内部域名。
		LOCALSTACK_LAMBDA_AWS_ENDPOINT_URL: lambdaEndpoint,
		CDK_DEFAULT_ACCOUNT: accountId,
		CDK_DEFAULT_REGION: region,
		DATABASE_URL:
			process.env.LOCALSTACK_DATABASE_URL ??
			"postgres://aicp_test:aicp_test_password@host.docker.internal:55432/aicp_test",
		AGENT_CREDENTIALS_KMS_KEY_ID: keyAlias,
		SIWE_EXPECTED_DOMAIN: "localhost:3001",
		SIWE_EXPECTED_URI: "http://localhost:3001",
		SIWE_EXPECTED_CHAIN_ID: "31337",
		DISPATCH_ENGINE_URL: "http://host.docker.internal:3200",
		DISPATCH_INTERNAL_TOKEN: internalToken,
		DISPATCH_INTERNAL_TOKEN_SECRET_ARN: resources.secretArn,
		ETHEREUM_RPC_URL: "http://host.docker.internal:8545",
		ESCROW_CHAIN_ID: "31337",
		ESCROW_CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000001",
		ESCROW_PAYMENT_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000002",
		ESCROW_START_BLOCK: "0",
		ESCROW_REQUIRED_CONFIRMATIONS: "2",
	};
}

async function deploy() {
	const resources = await bootstrap();
	const env = deploymentEnvironment(resources);
	run("pnpm", ["infra:build-lambda"], { cwd: appDirectory, env });
	run(
		"pnpm",
		["exec", "cdklocal", "bootstrap", `aws://${accountId}/${region}`],
		{ cwd: path.join(appDirectory, "infra"), env },
	);
	run(
		"pnpm",
		[
			"exec",
			"cdklocal",
			"deploy",
			"MarketplaceApiStack",
			"--require-approval",
			"never",
		],
		{ cwd: path.join(appDirectory, "infra"), env },
	);
	process.stdout.write("Marketplace API 已部署到 LocalStack\n");
}

async function verify() {
	if (containerState() !== "running") {
		throw new Error("LocalStack 尚未运行：请先执行 localstack:deploy");
	}
	await waitUntilReady();
	const resources = JSON.parse(await readFile(manifestPath, "utf8"));
	outputOfAws([
		"kms",
		"generate-data-key-without-plaintext",
		"--key-id",
		resources.keyAlias,
		"--key-spec",
		"AES_256",
	]);
	const storedToken = outputOfAws([
		"secretsmanager",
		"get-secret-value",
		"--secret-id",
		secretName,
		"--query",
		"SecretString",
		"--output",
		"text",
	]);
	if (storedToken !== internalToken)
		throw new Error("LocalStack Secret 内容不匹配");

	const deduplicationId = `localstack-${Date.now()}`;
	const messageBody = JSON.stringify({
		type: "localstack-smoke",
		verificationId: deduplicationId,
	});
	aws(
		[
			"sqs",
			"send-message",
			"--queue-url",
			resources.verificationQueueUrl,
			"--message-body",
			messageBody,
			"--message-group-id",
			"localstack-smoke",
			"--message-deduplication-id",
			deduplicationId,
		],
		{ capture: true },
	);
	let receiptHandle;
	for (let attempt = 0; attempt < 5 && !receiptHandle; attempt += 1) {
		const output = outputOfAws([
			"sqs",
			"receive-message",
			"--queue-url",
			resources.verificationQueueUrl,
			"--wait-time-seconds",
			"2",
			"--max-number-of-messages",
			"10",
		]);
		const received = output.length === 0 ? {} : JSON.parse(output);
		const message = received.Messages?.find(
			(candidate) => candidate.Body === messageBody,
		);
		receiptHandle = message?.ReceiptHandle;
	}
	if (!receiptHandle) throw new Error("LocalStack SQS 未返回刚写入的验收消息");
	aws([
		"sqs",
		"delete-message",
		"--queue-url",
		resources.verificationQueueUrl,
		"--receipt-handle",
		receiptHandle,
	]);
	aws(
		[
			"sns",
			"publish",
			"--topic-arn",
			resources.topicArn,
			"--message",
			'{"type":"localstack-smoke"}',
		],
		{ capture: true },
	);

	const stackStatus = outputOfAws([
		"cloudformation",
		"describe-stacks",
		"--stack-name",
		"MarketplaceApiStack",
		"--query",
		"Stacks[0].StackStatus",
		"--output",
		"text",
	]);
	if (stackStatus !== "CREATE_COMPLETE" && stackStatus !== "UPDATE_COMPLETE") {
		throw new Error(`MarketplaceApiStack 状态异常：${stackStatus}`);
	}

	const connectionName = stackPhysicalResourceId("AWS::Events::Connection");
	const apiDestinationName = stackPhysicalResourceId(
		"AWS::Events::ApiDestination",
	);
	const ruleName = stackPhysicalResourceId("AWS::Events::Rule");
	outputOfAws(["events", "describe-connection", "--name", connectionName]);
	outputOfAws([
		"events",
		"describe-api-destination",
		"--name",
		apiDestinationName,
	]);
	outputOfAws(["events", "describe-rule", "--name", ruleName]);
	const targetCount = outputOfAws([
		"events",
		"list-targets-by-rule",
		"--rule",
		ruleName,
		"--query",
		"length(Targets)",
		"--output",
		"text",
	]);
	if (targetCount !== "1") {
		throw new Error(`EventBridge 评分快照规则目标数异常：${targetCount}`);
	}

	const functionName = outputOfAws([
		"cloudformation",
		"describe-stacks",
		"--stack-name",
		"MarketplaceApiStack",
		"--query",
		"Stacks[0].Outputs[?OutputKey=='MarketplaceApiFunctionName'].OutputValue | [0]",
		"--output",
		"text",
	]);
	const event = {
		version: "2.0",
		routeKey: "GET /api/health",
		rawPath: "/api/health",
		rawQueryString: "",
		headers: { host: "localhost" },
		requestContext: {
			accountId,
			apiId: "localstack",
			domainName: "localhost",
			domainPrefix: "localhost",
			http: {
				method: "GET",
				path: "/api/health",
				protocol: "HTTP/1.1",
				sourceIp: "127.0.0.1",
				userAgent: "aicp-localstack-smoke",
			},
			requestId: deduplicationId,
			routeKey: "GET /api/health",
			stage: "$default",
			time: new Date().toISOString(),
			timeEpoch: Date.now(),
		},
		isBase64Encoded: false,
	};
	const invocation = JSON.parse(
		outputOfAws([
			"lambda",
			"invoke",
			"--function-name",
			functionName,
			"--cli-binary-format",
			"raw-in-base64-out",
			"--payload",
			JSON.stringify(event),
			lambdaResponsePath,
		]),
	);
	const lambdaResponse = JSON.parse(await readFile(lambdaResponsePath, "utf8"));
	if (invocation.FunctionError !== undefined) {
		throw new Error(
			`Marketplace API Lambda 执行失败（${invocation.FunctionError}）：${lambdaResponse.errorType ?? "Error"}: ${lambdaResponse.errorMessage ?? "未知错误"}`,
		);
	}
	if (lambdaResponse.statusCode !== 200) {
		throw new Error(
			`Marketplace API Lambda 健康检查失败：${lambdaResponse.statusCode}`,
		);
	}
	const body = JSON.parse(lambdaResponse.body);
	if (body.status !== "ok")
		throw new Error("Marketplace API Lambda 返回了异常健康状态");
	process.stdout.write(
		"LocalStack KMS、Secret、SQS、SNS、CloudFormation、EventBridge 与 Lambda 验收通过\n",
	);
}

async function status() {
	const state = containerState();
	process.stdout.write(`LocalStack 容器状态：${state}\n`);
	if (state === "running") await waitUntilReady();
}

function stop() {
	if (containerState() === "running") run("docker", ["stop", containerName]);
}

const command = process.argv[2];
switch (command) {
	case "start":
		await start();
		break;
	case "bootstrap":
		await bootstrap();
		break;
	case "deploy":
		await deploy();
		break;
	case "verify":
		await verify();
		break;
	case "status":
		await status();
		break;
	case "stop":
		stop();
		break;
	default:
		throw new Error(
			"用法：localstack.mjs <start|bootstrap|deploy|verify|status|stop>",
		);
}
