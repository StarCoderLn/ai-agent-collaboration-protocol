import { SessionInvalidError } from "../auth/resolve-actor-id";
import type { StoredTaskEvent } from "../tasks/task-event-repository";
import { withCredentialedCors } from "./cors";
import type { ExecutionRouteContext } from "./execution-handlers";

export interface TaskEventSseDeps {
	resolveActorId(request: Request): Promise<string>;
	canRead(taskId: string, actorId: string): Promise<boolean>;
	after(
		taskId: string,
		cursor: bigint,
		limit: number,
	): Promise<readonly StoredTaskEvent[]>;
	allowedOrigin: string;
	pollIntervalMs?: number;
	streamDurationMs?: number;
}

export function createTaskEventSseHandler(deps: TaskEventSseDeps) {
	return async (
		request: Request,
		context: ExecutionRouteContext,
	): Promise<Response> => {
		let actorId: string;
		try {
			actorId = await deps.resolveActorId(request);
		} catch (cause) {
			return response(deps, cause instanceof SessionInvalidError ? 401 : 503, {
				error_code:
					cause instanceof SessionInvalidError
						? "UNAUTHENTICATED"
						: "AUTH_SERVICE_UNAVAILABLE",
				message: "无法建立任务事件连接",
				retryable: !(cause instanceof SessionInvalidError),
			});
		}
		const { id } = await context.params;
		if (!isUuid(id) || !(await deps.canRead(id, actorId))) {
			return response(deps, 404, {
				error_code: "TASK_NOT_FOUND",
				message: "任务不存在或无权访问",
				retryable: false,
			});
		}
		const cursor = parseCursor(request.headers.get("last-event-id"));
		if (cursor === null)
			return response(deps, 400, {
				error_code: "INVALID_EVENT_CURSOR",
				message: "Last-Event-ID 格式不正确",
				retryable: false,
			});
		const stream = eventStream(id, cursor, request.signal, deps);
		return withCredentialedCors(
			new Response(stream, {
				status: 200,
				headers: {
					"content-type": "text/event-stream; charset=utf-8",
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive",
					"x-accel-buffering": "no",
				},
			}),
			deps.allowedOrigin,
		);
	};
}

function eventStream(
	taskId: string,
	initialCursor: bigint,
	signal: AbortSignal,
	deps: TaskEventSseDeps,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const pollMs = deps.pollIntervalMs ?? 1_000;
	const durationMs = deps.streamDurationMs ?? 25_000;
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			let cursor = initialCursor;
			const deadline = Date.now() + durationMs;
			try {
				while (!signal.aborted && Date.now() < deadline) {
					const events = await deps.after(taskId, cursor, 100);
					for (const event of events) {
						controller.enqueue(encoder.encode(serializeEvent(event)));
						cursor = BigInt(event.id);
					}
					if (events.length === 0)
						controller.enqueue(encoder.encode(": keep-alive\n\n"));
					await abortableDelay(
						Math.min(pollMs, Math.max(0, deadline - Date.now())),
						signal,
					);
				}
			} catch {
				// 连接失败时结束流，浏览器客户端会用最后收到的 event id 重连；不在 SSE 中泄漏
				// 数据库错误细节。前端超过重试阈值后改用 /status 补拉。
			} finally {
				controller.close();
			}
		},
	});
}

function serializeEvent(event: StoredTaskEvent): string {
	const data = JSON.stringify({
		taskId: event.taskId,
		statusVersion: event.statusVersion,
		payload: event.payload,
		createdAt: event.createdAt.toISOString(),
	});
	return `id: ${event.id}\nevent: ${event.eventType}\ndata: ${data}\n\n`;
}

function abortableDelay(
	milliseconds: number,
	signal: AbortSignal,
): Promise<void> {
	if (milliseconds <= 0 || signal.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const timeout = setTimeout(done, milliseconds);
		signal.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(timeout);
			signal.removeEventListener("abort", done);
			resolve();
		}
	});
}

function parseCursor(raw: string | null): bigint | null {
	if (raw === null || raw === "") return 0n;
	return /^(0|[1-9]\d*)$/.test(raw) ? BigInt(raw) : null;
}
function response(
	deps: TaskEventSseDeps,
	status: number,
	body: unknown,
): Response {
	return withCredentialedCors(
		Response.json(body, { status }),
		deps.allowedOrigin,
	);
}
function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
		value,
	);
}
