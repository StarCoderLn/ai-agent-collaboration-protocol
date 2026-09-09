import { describe, expect, it, vi } from "vitest";

import type { QueryExecutor } from "../db/pool";
import type { SubmitEvidenceInput } from "./dispute-input";
import { PgDisputeRepository } from "./dispute-repository";

const publisher = `0x${"11".repeat(20)}`;
const taskId = "10000000-0000-4000-8000-000000000001";
const disputeId = "10000000-0000-4000-8000-000000000002";
const now = new Date("2026-09-06T00:00:00Z");
const attachment = { name: "proof.pdf", mimeType: "application/pdf", sizeBytes: "1024", storageRef: "private:proof" };

describe("争议附件复用任务安全规则", () => {
  for (const entry of ["open", "submitEvidence"] as const) {
    it.each([
      { ...attachment, sizeBytes: "0" },
      { ...attachment, sizeBytes: "-1" },
      { ...attachment, name: "proof.EXE" },
      { ...attachment, name: "proof.sh" },
      { ...attachment, mimeType: "application/x-executable" },
    ])(`${entry} 拒绝零/负大小及被伪装或误配置放行的可执行文件 %j`, async (file) => {
      const repository = createRepository();
      const input = { description: "原始执行证据", attachments: [file] };
      await expect(submit(repository, entry, input)).rejects.toMatchObject({
        statusCode: 422, code: "EVIDENCE_ATTACHMENT_INVALID",
      });
    });
  }

  it.each(["1", "1024"])("保留合法附件，大小 %s 包含分类上限", async (sizeBytes) => {
    await expect(submit(createRepository(), "submitEvidence", {
      description: "原始执行证据", attachments: [{ ...attachment, sizeBytes }],
    })).resolves.toMatchObject({ statusCode: 201, body: { party: "publisher" } });
  });

  it("保留无附件证据", async () => {
    await expect(submit(createRepository(), "submitEvidence", {
      description: "原始执行证据", attachments: [],
    })).resolves.toMatchObject({ statusCode: 201 });
  });

  it.each([
    { attachments: [{ ...attachment, sizeBytes: "1025" }], code: "EVIDENCE_ATTACHMENT_INVALID" },
    { attachments: [{ ...attachment, mimeType: "image/png" }], code: "EVIDENCE_ATTACHMENT_INVALID" },
    { attachments: [attachment, attachment, attachment], code: "EVIDENCE_ATTACHMENT_LIMIT" },
  ])("继续按当前分类拒绝超限或非白名单附件 %j", async ({ attachments, code }) => {
    await expect(submit(createRepository(), "submitEvidence", {
      description: "原始执行证据", attachments,
    })).rejects.toMatchObject({ statusCode: 422, code });
  });
});

function submit(repository: PgDisputeRepository, entry: "open" | "submitEvidence", input: SubmitEvidenceInput) {
  return entry === "open"
    ? repository.open(taskId, publisher, { reason: "交付结果未达到约定验收要求", initialEvidence: input }, now)
    : repository.submitEvidence(disputeId, publisher, input, now);
}

/**
 * 数据库替身提供合法当事人、举证窗口和分类配置，测试通过两个公开写入口验证安全边界。
 * 分类故意误放行可执行 MIME，用于证明跨分类禁令不能被配置覆盖；不依赖查询调用顺序。
 */
function createRepository(): PgDisputeRepository {
  const db: QueryExecutor = { query: async () => { throw new Error("数据库替身尚未装配"); } };
  const query = vi.spyOn(db, "query");
  query.mockImplementation(async (sql) => {
    if (sql.includes("to_regclass('dispute_evidence_objects')")) {
      return { rows: [{ available: false }], rowCount: 1 };
    }
    if (sql.includes("to_regclass")) return { rows: [{ available: true }], rowCount: 1 };
    if (sql.includes("attachment_category_limits")) return {
      rows: [{ max_files: 2, max_file_size_bytes: "1024", allowed_mime_types: ["application/pdf", "application/x-executable"] }], rowCount: 1,
    };
    if (sql.includes("CROSS JOIN dispute_config")) return {
      rows: [{ status: "executing", status_version: "1", publisher_id: publisher,
        agent_provider_ids: [`0x${"22".repeat(20)}`], evidence_window_seconds: 3600 }], rowCount: 1,
    };
    if (sql.includes("FOR UPDATE OF dispute,task")) return {
      rows: [{ id: disputeId, task_id: taskId, opened_by: publisher, reason: "待仲裁",
        status: "evidence_collection", evidence_deadline: new Date(now.getTime() + 3600_000),
        funds_frozen: true, created_at: now, updated_at: now, publisher_id: publisher,
        agent_provider_ids: [`0x${"22".repeat(20)}`], status_version: "1" }], rowCount: 1,
    };
    return { rows: [], rowCount: 0 };
  });
  return new PgDisputeRepository(db, { chainId: 31337n, contractAddress: `0x${"33".repeat(20)}` });
}
