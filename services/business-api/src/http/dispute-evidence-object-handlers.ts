import { SessionInvalidError } from "../auth/resolve-actor-id";
import { DisputeEvidenceObjectError } from "../disputes/dispute-evidence-object";
import { withCredentialedCors } from "./cors";

const MAX_REQUEST_BYTES = 21 * 1_048_576;

export type DisputeEvidenceObjectRouteContext = Readonly<{
	params: Promise<{ id: string; objectId?: string }>;
}>;

export interface DisputeEvidenceObjectHttpDeps {
	resolveActorId(request: Request): Promise<string>;
	allowedOrigin: string;
	store(
		input: Readonly<{
			disputeId: string;
			actorId: string;
			name: string;
			mimeType: string;
			content: Uint8Array;
		}>,
	): Promise<Readonly<Record<string, unknown>>>;
	read(
		disputeId: string,
		objectId: string,
		actorId: string,
	): Promise<Readonly<{ name: string; mimeType: string; content: Uint8Array }>>;
}

export function createDisputeEvidenceObjectHandlers(
	deps: DisputeEvidenceObjectHttpDeps,
) {
	return {
		upload: async (
			request: Request,
			context: DisputeEvidenceObjectRouteContext,
		) => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const disputeId = await routeId(context, "id");
			if (disputeId === null)
				return failure(deps, 404, "DISPUTE_NOT_FOUND", "争议不存在");
			const contentLength = Number(
				request.headers.get("content-length") ?? "0",
			);
			if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
				return failure(
					deps,
					413,
					"EVIDENCE_ATTACHMENT_TOO_LARGE",
					"证据文件超过上传上限",
				);
			}
			let form: FormData;
			try {
				form = await request.formData();
			} catch {
				return failure(
					deps,
					400,
					"EVIDENCE_MULTIPART_INVALID",
					"上传内容不是有效文件表单",
				);
			}
			const file = form.get("file");
			if (!(file instanceof File)) {
				return failure(deps, 422, "EVIDENCE_FILE_REQUIRED", "请选择证据文件");
			}
			try {
				const stored = await deps.store({
					disputeId,
					actorId: actor,
					name: file.name,
					mimeType: file.type || "application/octet-stream",
					content: new Uint8Array(await file.arrayBuffer()),
				});
				return response(deps, 201, stored);
			} catch (error) {
				return objectFailure(deps, error);
			}
		},
		download: async (
			request: Request,
			context: DisputeEvidenceObjectRouteContext,
		) => {
			const actor = await resolveActor(request, deps);
			if (actor instanceof Response) return actor;
			const disputeId = await routeId(context, "id");
			const objectId = await routeId(context, "objectId");
			if (disputeId === null || objectId === null) {
				return failure(
					deps,
					404,
					"EVIDENCE_OBJECT_NOT_FOUND",
					"证据文件不存在",
				);
			}
			try {
				const object = await deps.read(disputeId, objectId, actor);
				const responseBody = Uint8Array.from(object.content).buffer;
				return withCredentialedCors(
					new Response(responseBody, {
						status: 200,
						headers: {
							"Content-Type": object.mimeType,
							"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(object.name)}`,
							"Cache-Control": "private, no-store",
							"X-Content-Type-Options": "nosniff",
						},
					}),
					deps.allowedOrigin,
				);
			} catch (error) {
				return objectFailure(deps, error);
			}
		},
	};
}

async function resolveActor(
	request: Request,
	deps: DisputeEvidenceObjectHttpDeps,
) {
	try {
		return await deps.resolveActorId(request);
	} catch (error) {
		return error instanceof SessionInvalidError
			? failure(deps, 401, "UNAUTHENTICATED", "无法验证当前身份")
			: failure(
					deps,
					503,
					"AUTH_SERVICE_UNAVAILABLE",
					"身份服务暂不可用",
					true,
				);
	}
}

async function routeId(
	context: DisputeEvidenceObjectRouteContext,
	key: "id" | "objectId",
): Promise<string | null> {
	const value = (await context.params)[key];
	return value !== undefined &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
			value,
		)
		? value.toLowerCase()
		: null;
}

function objectFailure(deps: DisputeEvidenceObjectHttpDeps, error: unknown) {
	return error instanceof DisputeEvidenceObjectError
		? failure(deps, error.statusCode, error.code, error.message)
		: failure(
				deps,
				500,
				"EVIDENCE_OBJECT_INTERNAL_ERROR",
				"证据文件操作失败",
				true,
			);
}

function response(
	deps: DisputeEvidenceObjectHttpDeps,
	status: number,
	body: unknown,
) {
	return withCredentialedCors(
		Response.json(body, { status }),
		deps.allowedOrigin,
	);
}

function failure(
	deps: DisputeEvidenceObjectHttpDeps,
	status: number,
	code: string,
	message: string,
	retryable = false,
) {
	return response(deps, status, { error_code: code, message, retryable });
}
