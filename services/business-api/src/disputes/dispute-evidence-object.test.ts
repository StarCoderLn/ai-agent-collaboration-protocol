import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "../db/pool";
import {
	readDisputeEvidenceObject,
	storeDisputeEvidenceObject,
	verifyEvidenceObjects,
} from "./dispute-evidence-object";

const disputeId = "10000000-0000-4000-8000-000000000001";
const objectId = "10000000-0000-4000-8000-000000000002";
const actorId = `0x${"11".repeat(20)}`;
const now = new Date("2026-09-09T00:00:00Z");

describe("不可变争议证据文件", () => {
	it("上传时按实际字节生成内容寻址引用并保存正文", async () => {
		const content = new TextEncoder().encode("不可变证据");
		const db = database([
			{
				rows: [
					{
						status: "evidence_collection",
						evidence_deadline: new Date("2026-09-10T00:00:00Z"),
						publisher_id: actorId,
						authorized_agent: false,
						max_files: 2,
						max_file_size_bytes: "1024",
						allowed_mime_types: ["text/plain"],
					},
				],
				rowCount: 1,
			},
			{ rows: [], rowCount: 1 },
		]);
		const stored = await storeDisputeEvidenceObject(db, {
			disputeId,
			actorId,
			name: "proof.txt",
			mimeType: "text/plain",
			content,
			now,
		});
		const sha256 = createHash("sha256").update(content).digest("hex");
		expect(stored).toMatchObject({
			name: "proof.txt",
			mimeType: "text/plain",
			sizeBytes: String(content.byteLength),
			sha256: `0x${sha256}`,
		});
		expect(stored.storageRef).toMatch(
			new RegExp(`^evidence-db:[0-9a-f-]{36}:${sha256}$`),
		);
	});

	it("提交时拒绝摘要与数据库正文不一致的引用", async () => {
		const declared = Buffer.from("declared");
		const tampered = Buffer.from("tampered");
		const sha256 = createHash("sha256").update(declared).digest("hex");
		const db = database([
			{ rows: [{ available: true }], rowCount: 1 },
			{
				rows: [
					{
						id: objectId,
						uploaded_by: actorId,
						original_name: "proof.txt",
						mime_type: "text/plain",
						size_bytes: String(tampered.byteLength),
						sha256,
						content: tampered,
						evidence_id: null,
					},
				],
				rowCount: 1,
			},
		]);
		await expect(
			verifyEvidenceObjects(db, disputeId, actorId, [
				{
					name: "proof.txt",
					mimeType: "text/plain",
					sizeBytes: String(tampered.byteLength),
					storageRef: `evidence-db:${objectId}:${sha256}`,
				},
			]),
		).rejects.toMatchObject({ code: "EVIDENCE_ATTACHMENT_REFERENCE_INVALID" });
	});

	it("下载已提交文件时重新计算摘要，损坏正文不返回给当事人", async () => {
		const db = database([
			{
				rows: [
					{
						original_name: "proof.txt",
						mime_type: "text/plain",
						sha256: "0".repeat(64),
						content: Buffer.from("changed"),
						authorized: true,
					},
				],
				rowCount: 1,
			},
		]);
		await expect(
			readDisputeEvidenceObject(db, disputeId, objectId, actorId),
		).rejects.toMatchObject({
			code: "EVIDENCE_OBJECT_INTEGRITY_FAILED",
			statusCode: 500,
		});
	});
});

function database(
	results: readonly Readonly<{ rows: unknown[]; rowCount: number }>[],
): QueryExecutor {
	const query = vi.fn();
	for (const result of results) query.mockResolvedValueOnce(result);
	return { query } as unknown as QueryExecutor;
}
