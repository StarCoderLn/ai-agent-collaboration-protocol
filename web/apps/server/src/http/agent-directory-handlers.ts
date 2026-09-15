import type { PgAgentDirectory } from "../agents/agent-directory";
import { SessionInvalidError } from "../auth/resolve-actor-id";
import { withCredentialedCors } from "./cors";

export type AgentDirectoryRouteContext = Readonly<{
	params: Promise<{ id: string }>;
}>;
export interface AgentDirectoryHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	directory: PgAgentDirectory;
	allowedOrigin: string;
}

export function createAgentDirectoryHandlers(deps: AgentDirectoryHttpDeps) {
	return {
		publicList: (request: Request) => publicList(deps, request),
		publicDetail: (context: AgentDirectoryRouteContext) =>
			publicDetail(deps, context),
		owned: (request: Request) => owned(deps, request),
	};
}

async function publicList(
	deps: AgentDirectoryHttpDeps,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	const limit = boundedInteger(url.searchParams.get("limit"), 20, 1, 50);
	const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, 10_000);
	if (limit === null || offset === null)
		return response(
			deps,
			422,
			errorBody("VALIDATION_FAILED", "分页参数无效", false),
		);
	const keyword = (url.searchParams.get("keyword") ?? "").trim();
	if ([...keyword].length > 100)
		return response(
			deps,
			422,
			errorBody("VALIDATION_FAILED", "关键词最多 100 个字符", false),
		);
	const rawCategoryId = url.searchParams.get("category");
	const categoryId =
		rawCategoryId === null || rawCategoryId.trim() === ""
			? null
			: rawCategoryId;
	if (categoryId !== null && !isUuid(categoryId))
		return response(
			deps,
			422,
			errorBody("VALIDATION_FAILED", "Agent 分类格式不正确", false),
		);
	try {
		const page = await deps.directory.publicAgents({
			keyword,
			categoryId,
			limit,
			offset,
		});
		return response(deps, 200, { ...page, limit, offset });
	} catch {
		return response(
			deps,
			503,
			errorBody("AGENT_DIRECTORY_UNAVAILABLE", "Agent 市场暂不可用", true),
		);
	}
}

async function publicDetail(
	deps: AgentDirectoryHttpDeps,
	context: AgentDirectoryRouteContext,
): Promise<Response> {
	const { id } = await context.params;
	if (!isUuid(id))
		return response(
			deps,
			404,
			errorBody("AGENT_NOT_FOUND", "Agent 不存在", false),
		);
	try {
		const agent = await deps.directory.publicAgent(id);
		return agent === null
			? response(deps, 404, errorBody("AGENT_NOT_FOUND", "Agent 不存在", false))
			: response(deps, 200, { agent });
	} catch {
		return response(
			deps,
			503,
			errorBody("AGENT_DIRECTORY_UNAVAILABLE", "Agent 市场暂不可用", true),
		);
	}
}

async function owned(
	deps: AgentDirectoryHttpDeps,
	request: Request,
): Promise<Response> {
	const actor = await requiredActor(deps, request);
	if (actor instanceof Response) return actor;
	try {
		return response(deps, 200, {
			agents: await deps.directory.ownedAgents(actor),
		});
	} catch {
		return response(
			deps,
			503,
			errorBody("AGENT_DIRECTORY_UNAVAILABLE", "Agent 管理列表暂不可用", true),
		);
	}
}

async function requiredActor(
	deps: AgentDirectoryHttpDeps,
	request: Request,
): Promise<string | Response> {
	try {
		return await deps.resolveActorId(request);
	} catch (error) {
		return error instanceof SessionInvalidError
			? response(deps, 401, errorBody("UNAUTHENTICATED", "身份认证失败", false))
			: response(
					deps,
					503,
					errorBody("AUTH_SERVICE_UNAVAILABLE", "认证服务暂不可用", true),
				);
	}
}

function response(
	deps: AgentDirectoryHttpDeps,
	status: number,
	body: unknown,
): Response {
	return withCredentialedCors(
		Response.json(body, { status }),
		deps.allowedOrigin,
	);
}
function errorBody(error_code: string, message: string, retryable: boolean) {
	return { error_code, message, retryable };
}
function boundedInteger(
	raw: string | null,
	fallback: number,
	minimum: number,
	maximum: number,
): number | null {
	if (raw === null) return fallback;
	if (!/^\d+$/.test(raw)) return null;
	const value = Number.parseInt(raw, 10);
	return value < minimum || value > maximum ? null : value;
}
function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}
