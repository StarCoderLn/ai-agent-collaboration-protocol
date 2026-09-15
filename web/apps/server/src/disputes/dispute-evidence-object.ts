import { createHash, randomUUID } from "node:crypto";

import type { QueryExecutor } from "../db/pool";
import { validateTaskAttachments } from "../platform/task-validation";
import type { SubmitEvidenceInput } from "./dispute-input";

const DEFAULT_MAX_BYTES = 20 * 1_048_576;
const DEFAULT_MIME_TYPES = [
	"application/pdf",
	"image/png",
	"image/jpeg",
	"text/plain",
];
const STORAGE_REF = /^evidence-db:([0-9a-f-]{36}):([0-9a-f]{64})$/;

export class DisputeEvidenceObjectError extends Error {
	constructor(
		readonly statusCode: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export async function storeDisputeEvidenceObject(
	db: QueryExecutor,
	input: Readonly<{
		disputeId: string;
		actorId: string;
		name: string;
		mimeType: string;
		content: Uint8Array;
		now: Date;
	}>,
) {
	const context = await lockUploadContext(
		db,
		input.disputeId,
		input.actorId,
		input.now,
	);
	const id = randomUUID();
	const mimeType = input.mimeType.toLowerCase();
	const sha256 = digest(input.content);
	const storageRef = `evidence-db:${id}:${sha256}`;
	const attachment = {
		name: input.name,
		mimeType,
		sizeBytes: BigInt(input.content.byteLength),
		storageRef,
	};
	const issue = validateTaskAttachments([attachment], context.limit)[0];
	if (issue !== undefined) {
		throw new DisputeEvidenceObjectError(
			422,
			"EVIDENCE_ATTACHMENT_INVALID",
			issue.message,
		);
	}
	await db.query(
		`INSERT INTO dispute_evidence_objects(
		   id,dispute_id,uploaded_by,original_name,mime_type,size_bytes,sha256,content,created_at
		 ) VALUES ($1,$2,lower($3),$4,$5,$6,$7,$8,$9)`,
		[
			id,
			input.disputeId,
			input.actorId,
			input.name,
			mimeType,
			input.content.byteLength,
			sha256,
			Buffer.from(input.content),
			input.now,
		],
	);
	return {
		id,
		name: input.name,
		mimeType,
		sizeBytes: String(input.content.byteLength),
		storageRef,
		sha256: `0x${sha256}`,
	};
}

export async function readDisputeEvidenceObject(
	db: QueryExecutor,
	disputeId: string,
	objectId: string,
	actorId: string,
) {
	const result = await db.query<{
		original_name: string;
		mime_type: string;
		sha256: string;
		content: Buffer;
		authorized: boolean;
	}>(
		`SELECT object.original_name,object.mime_type,object.sha256,object.content,
		        (lower(task.publisher_id)=lower($3)
		         OR EXISTS(SELECT 1 FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
		              WHERE assignment.task_id=task.id AND assignment.status='accepted'
		                AND lower(agent.provider_wallet_address)=lower($3))
		         OR EXISTS(SELECT 1 FROM platform_actor_roles role
		              WHERE lower(role.actor_id)=lower($3) AND role.role='arbitrator')
		         OR EXISTS(SELECT 1 FROM dao_arbitration_rounds round
		              JOIN dao_arbitration_panel_members panel ON panel.round_id=round.id
		             WHERE round.dispute_id=dispute.id AND lower(panel.actor_id)=lower($3))
		        ) AS authorized
		   FROM dispute_evidence_objects object
		   JOIN disputes dispute ON dispute.id=object.dispute_id
		   JOIN tasks task ON task.id=dispute.task_id
		  WHERE object.dispute_id=$1 AND object.id=$2 AND object.evidence_id IS NOT NULL`,
		[disputeId, objectId, actorId],
	);
	const row = result.rows[0];
	if (row === undefined || !row.authorized) {
		throw new DisputeEvidenceObjectError(
			404,
			"EVIDENCE_OBJECT_NOT_FOUND",
			"证据文件不存在",
		);
	}
	if (digest(row.content) !== row.sha256) {
		throw new DisputeEvidenceObjectError(
			500,
			"EVIDENCE_OBJECT_INTEGRITY_FAILED",
			"证据文件完整性校验失败",
		);
	}
	return {
		name: row.original_name,
		mimeType: row.mime_type,
		content: row.content,
	};
}

/** 提交正文前锁定全部暂存对象；任一元数据或摘要不一致时整笔证据事务回滚。 */
export async function verifyEvidenceObjects(
	db: QueryExecutor,
	disputeId: string,
	actorId: string,
	attachments: SubmitEvidenceInput["attachments"],
): Promise<readonly string[]> {
	if (attachments.length === 0 || !(await hasObjectSchema(db))) return [];
	const ids = attachments.map(
		(attachment) => parseStorageRef(attachment.storageRef).id,
	);
	const rows = await db.query<{
		id: string;
		uploaded_by: string;
		original_name: string;
		mime_type: string;
		size_bytes: string;
		sha256: string;
		content: Buffer;
		evidence_id: string | null;
	}>(
		`SELECT id::text,uploaded_by,original_name,mime_type,size_bytes::text,sha256,content,evidence_id::text
		   FROM dispute_evidence_objects
		  WHERE dispute_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE`,
		[disputeId, ids],
	);
	if (rows.rows.length !== attachments.length) throw invalidReference();
	for (const attachment of attachments) {
		const parsed = parseStorageRef(attachment.storageRef);
		const row = rows.rows.find((candidate) => candidate.id === parsed.id);
		if (
			row === undefined ||
			row.evidence_id !== null ||
			row.uploaded_by.toLowerCase() !== actorId.toLowerCase() ||
			row.original_name !== attachment.name ||
			row.mime_type !== attachment.mimeType.toLowerCase() ||
			row.size_bytes !== attachment.sizeBytes ||
			row.sha256 !== parsed.sha256 ||
			digest(row.content) !== row.sha256
		) {
			throw invalidReference();
		}
	}
	return ids;
}

export async function commitEvidenceObjects(
	db: QueryExecutor,
	objectIds: readonly string[],
	evidenceId: string,
	now: Date,
): Promise<void> {
	if (objectIds.length === 0) return;
	const updated = await db.query(
		`UPDATE dispute_evidence_objects SET evidence_id=$2,committed_at=$3
		  WHERE id=ANY($1::uuid[]) AND evidence_id IS NULL`,
		[objectIds, evidenceId, now],
	);
	if (updated.rowCount !== objectIds.length) throw invalidReference();
}

async function lockUploadContext(
	db: QueryExecutor,
	disputeId: string,
	actorId: string,
	now: Date,
) {
	const result = await db.query<{
		status: string;
		evidence_deadline: Date;
		publisher_id: string;
		authorized_agent: boolean;
		max_files: number | null;
		max_file_size_bytes: string | null;
		allowed_mime_types: string[] | null;
	}>(
		`SELECT dispute.status,dispute.evidence_deadline,task.publisher_id,
		        EXISTS(SELECT 1 FROM task_assignments assignment JOIN agents agent ON agent.id=assignment.agent_id
		          WHERE assignment.task_id=task.id AND assignment.status='accepted'
		            AND lower(agent.provider_wallet_address)=lower($2)) AS authorized_agent,
		        limits.max_files,limits.max_file_size_bytes::text,limits.allowed_mime_types
		   FROM disputes dispute JOIN tasks task ON task.id=dispute.task_id
		   LEFT JOIN attachment_category_limits limits ON limits.category_id=task.category_id
		  WHERE dispute.id=$1 FOR UPDATE OF dispute`,
		[disputeId, actorId],
	);
	const row = result.rows[0];
	if (
		row === undefined ||
		(row.publisher_id.toLowerCase() !== actorId.toLowerCase() &&
			!row.authorized_agent)
	) {
		throw new DisputeEvidenceObjectError(
			404,
			"DISPUTE_NOT_FOUND",
			"争议不存在",
		);
	}
	if (
		row.status !== "evidence_collection" ||
		row.evidence_deadline.getTime() <= now.getTime()
	) {
		throw new DisputeEvidenceObjectError(
			409,
			"EVIDENCE_COLLECTION_CLOSED",
			"证据收集已经结束",
		);
	}
	return {
		limit: {
			maxFiles: row.max_files ?? 10,
			maxFileSizeBytes: BigInt(row.max_file_size_bytes ?? DEFAULT_MAX_BYTES),
			allowedMimeTypes: new Set(
				(row.allowed_mime_types ?? DEFAULT_MIME_TYPES).map((value) =>
					value.toLowerCase(),
				),
			),
		},
	};
}

async function hasObjectSchema(db: QueryExecutor): Promise<boolean> {
	const result = await db.query<{ available: boolean }>(
		"SELECT to_regclass('dispute_evidence_objects') IS NOT NULL AS available",
		[],
	);
	return result.rows[0]?.available === true;
}

function parseStorageRef(value: string) {
	const matched = STORAGE_REF.exec(value);
	if (matched?.[1] === undefined || matched[2] === undefined)
		throw invalidReference();
	return { id: matched[1], sha256: matched[2] };
}

function digest(content: Uint8Array): string {
	return createHash("sha256").update(content).digest("hex");
}

function invalidReference() {
	return new DisputeEvidenceObjectError(
		422,
		"EVIDENCE_ATTACHMENT_REFERENCE_INVALID",
		"证据文件未由当前案件上传、已被使用或完整性校验失败",
	);
}
