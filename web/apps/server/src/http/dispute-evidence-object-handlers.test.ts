import { describe, expect, it, vi } from "vitest";

import { SessionInvalidError } from "../auth/resolve-actor-id";
import { DisputeEvidenceObjectError } from "../disputes/dispute-evidence-object";
import {
	createDisputeEvidenceObjectHandlers,
	type DisputeEvidenceObjectHttpDeps,
} from "./dispute-evidence-object-handlers";

const disputeId = "10000000-0000-4000-8000-000000000001";
const objectId = "10000000-0000-4000-8000-000000000002";
const actorId = `0x${"11".repeat(20)}`;
const allowedOrigin = "http://127.0.0.1:3011";

describe("争议证据文件 HTTP 边界", () => {
	it("将真实 multipart 文件字节和可信身份交给存储边界", async () => {
		const store = vi.fn(
			async (
				_input: Parameters<DisputeEvidenceObjectHttpDeps["store"]>[0],
			) => ({
				objectId,
				name: "proof.txt",
				mimeType: "text/plain",
				sizeBytes: "12",
				sha256: `0x${"22".repeat(32)}`,
				storageRef: `evidence-db:${objectId}:${"22".repeat(32)}`,
			}),
		);
		const handlers = createDisputeEvidenceObjectHandlers(deps({ store }));
		const form = new FormData();
		form.set(
			"file",
			new File([new TextEncoder().encode("真实证据")], "proof.txt", {
				type: "text/plain",
			}),
		);

		const response = await handlers.upload(
			new Request(`http://api.local/api/disputes/${disputeId}/attachments`, {
				method: "POST",
				body: form,
			}),
			context({ id: disputeId }),
		);

		expect(response.status).toBe(201);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			allowedOrigin,
		);
		expect(store).toHaveBeenCalledWith(
			expect.objectContaining({
				disputeId,
				actorId,
				name: "proof.txt",
				mimeType: "text/plain",
				content: expect.any(Uint8Array),
			}),
		);
		expect(new TextDecoder().decode(store.mock.calls[0]?.[0].content)).toBe(
			"真实证据",
		);
	});

	it("身份失效和超出请求上限时均不读取或写入文件", async () => {
		const unauthenticated = createDisputeEvidenceObjectHandlers(
			deps({
				resolveActorId: async () => {
					throw new SessionInvalidError();
				},
			}),
		);
		const unauthorized = await unauthenticated.upload(
			new Request("http://api.local/upload", { method: "POST" }),
			context({ id: disputeId }),
		);
		expect(unauthorized.status).toBe(401);

		const store = vi.fn();
		const handlers = createDisputeEvidenceObjectHandlers(deps({ store }));
		const oversized = await handlers.upload(
			new Request("http://api.local/upload", {
				method: "POST",
				headers: { "content-length": String(22 * 1_048_576) },
			}),
			context({ id: disputeId }),
		);
		expect(oversized.status).toBe(413);
		expect(store).not.toHaveBeenCalled();
	});

	it("授权下载返回不可嗅探且禁止缓存的原始字节", async () => {
		const content = new TextEncoder().encode("downloaded evidence");
		const handlers = createDisputeEvidenceObjectHandlers(
			deps({
				read: async () => ({
					name: "proof record.txt",
					mimeType: "text/plain",
					content,
				}),
			}),
		);
		const response = await handlers.download(
			new Request("http://api.local/download"),
			context({ id: disputeId, objectId }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-disposition")).toContain(
			"proof%20record.txt",
		);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(content);
	});

	it("领域校验错误保留稳定状态码和错误码", async () => {
		const handlers = createDisputeEvidenceObjectHandlers(
			deps({
				store: async () => {
					throw new DisputeEvidenceObjectError(
						422,
						"EVIDENCE_ATTACHMENT_MIME_FORBIDDEN",
						"不支持该证据文件类型",
					);
				},
			}),
		);
		const form = new FormData();
		form.set("file", new File(["binary"], "proof.exe"));
		const response = await handlers.upload(
			new Request("http://api.local/upload", { method: "POST", body: form }),
			context({ id: disputeId }),
		);

		expect(response.status).toBe(422);
		await expect(response.json()).resolves.toMatchObject({
			error_code: "EVIDENCE_ATTACHMENT_MIME_FORBIDDEN",
			retryable: false,
		});
	});
});

function deps(
	overrides: Partial<DisputeEvidenceObjectHttpDeps> = {},
): DisputeEvidenceObjectHttpDeps {
	return {
		resolveActorId: async () => actorId,
		allowedOrigin,
		store: async () => ({}),
		read: async () => ({
			name: "proof.txt",
			mimeType: "text/plain",
			content: new Uint8Array(),
		}),
		...overrides,
	};
}

function context(params: { id: string; objectId?: string }) {
	return { params: Promise.resolve(params) };
}
