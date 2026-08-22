import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { GenerateDataKeyCommand, type GenerateDataKeyCommandOutput } from "@aws-sdk/client-kms";

import { EnvelopeEncryptor, type KmsLike } from "../crypto/envelope-encryption.js";
import { Idempotency, type IdempotencyStore, type ResponseSnapshot } from "../idempotency/idempotency-store.js";
import { createAgent, ApiError, type CreateAgentDeps } from "./create-agent.js";
import type { AgentRepository as CreateAgentRepository, CreatedAgent } from "./agent-repository.js";
import { patchAgent } from "./patch-agent.js";
import { replaceAgentCredentials, type AgentCredentialStore, type CredentialEncryptor } from "./credentials.js";
import type { Agent, AgentPatch, AgentRepository, AuditLogEntry, AuditLogWriter } from "./agent.js";

/**
 * T-008 集成测试：串起 T-003/T-004/T-005 的真实业务逻辑模块（不 mock 单个函数调用，
 * 而是像生产环境一样把 createAgent/patchAgent/replaceAgentCredentials 与真实的
 * EnvelopeEncryptor（T-002）、Idempotency（1.T-006 同构实现）接在一起），验证跨模块边界
 * 的行为：必填校验、凭证不可明文落库、审计日志写入、重复提交幂等。
 *
 * 说明：services/business-api 尚未有可用的 Postgres/AWS KMS 测试环境（无 DATABASE_URL、
 * 无 docker-compose/testcontainers 测试基础设施，见本 task 回报的 blockers），因此持久化
 * 边界用忠实复刻 `PgAgentRepository`/`PgIdempotencyStore` 状态机语义的内存双替代
 * （与 envelope-encryption.test.ts 用 fake KMS client 而非真实 AWS 是同一套项目既有约定），
 * KMS 边界同样只替换传输层，加密/打包逻辑全部走真实 `EnvelopeEncryptor` 实现。
 * 搭建真实 Postgres 集成环境（docker-compose/testcontainers）超出本 task 范围，已在
 * blockers 中说明，作为后续建议。
 */

const WALLET_ADDRESS = "0x1234567890123456789012345678901234567890";

function makeFakeKms(): KmsLike {
  const send = vi.fn(async (_command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput> => ({
    Plaintext: randomBytes(32),
    CiphertextBlob: randomBytes(48),
    KeyId: "test-key",
    $metadata: {},
  }));
  return { send };
}

function makeEncryptor(): EnvelopeEncryptor {
  return new EnvelopeEncryptor({ kmsKeyId: "alias/agent-credentials" }, makeFakeKms());
}

/**
 * 忠实复刻 `PgIdempotencyStore`（idempotency-store.ts）的状态机语义：
 * INSERT ... ON CONFLICT DO NOTHING 的占位/提交两阶段行为，而非简单的 Map.has 判断，
 * 确保"并发重复请求命中 pending"这条真实 DB 行为在集成测试里同样成立。
 */
class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, { operationType: string; snapshot: ResponseSnapshot | null }>();

  async reserve(key: string, operationType: string, _expiresAt: Date) {
    if (!this.records.has(key)) {
      this.records.set(key, { operationType, snapshot: null });
      return { inserted: true, committed: false, snapshot: null };
    }
    const existing = this.records.get(key)!;
    if (existing.snapshot === null) {
      return { inserted: false, committed: false, snapshot: null };
    }
    return { inserted: false, committed: true, snapshot: existing.snapshot };
  }

  async commitResponse(key: string, snapshot: ResponseSnapshot) {
    const existing = this.records.get(key);
    if (!existing || existing.snapshot !== null) {
      throw new Error(`InMemoryIdempotencyStore.commitResponse: key "${key}" 未处于 pending 状态`);
    }
    existing.snapshot = snapshot;
  }
}

interface StoredAgentRow {
  agentId: string;
  status: string;
  encryptedSecret: string;
}

/** 忠实复刻 `PgAgentRepository`：把 agents + agent_credentials 的写入当作一次不可分割的操作。 */
class InMemoryCreateAgentRepository implements CreateAgentRepository {
  readonly rows: StoredAgentRow[] = [];
  private nextId = 1;

  async createAgentWithCredential(
    input: Parameters<CreateAgentRepository["createAgentWithCredential"]>[0],
    encryptedSecret: string,
  ): Promise<CreatedAgent> {
    const agentId = `agent-${this.nextId++}`;
    this.rows.push({ agentId, status: "pending_review", encryptedSecret });
    return { agentId, status: "pending_review" };
  }
}

/** 忠实复刻 `audit_logs` 表：只 append，供测试断言写入内容与数量。 */
class InMemoryAuditLogWriter implements AuditLogWriter {
  readonly entries: AuditLogEntry[] = [];
  async write(entry: AuditLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

function makeCreateDeps(overrides?: {
  repository?: CreateAgentRepository;
  idempotencyStore?: IdempotencyStore;
  auditLogWriter?: AuditLogWriter;
}): CreateAgentDeps & { repository: InMemoryCreateAgentRepository | CreateAgentRepository } {
  const repository = overrides?.repository ?? new InMemoryCreateAgentRepository();
  const idempotency = new Idempotency(overrides?.idempotencyStore ?? new InMemoryIdempotencyStore());
  const auditLogWriter = overrides?.auditLogWriter ?? new InMemoryAuditLogWriter();
  return { repository, encryptor: makeEncryptor(), idempotency, auditLogWriter };
}

function validCreateBody(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    name: "My Agent",
    categoryId: "11111111-1111-4111-8111-111111111111",
    capabilityDesc: "does things",
    tags: ["tag-a"],
    pricingType: "fixed",
    price: { amount: "1000", currency: "USDC" },
    walletAddress: WALLET_ADDRESS,
    serviceEndpoint: "https://agent.example.com",
    credentialSecret: "top-secret-api-key",
    email: "provider@example.com",
    ...overrides,
  };
}

describe("Agent 注册集成流程：必填校验（含邮箱）", () => {
  const REQUIRED_FIELD_CASES: Array<{ field: string; overrides: Record<string, unknown> }> = [
    { field: "name", overrides: { name: "" } },
    { field: "categoryId", overrides: { categoryId: "not-a-uuid" } },
    { field: "capabilityDesc", overrides: { capabilityDesc: "" } },
    { field: "tags", overrides: { tags: [] } },
    { field: "pricingType", overrides: { pricingType: "" } },
    {
      field: "price.amount",
      overrides: { price: { amount: "9223372036854775808", currency: "USDC" } },
    },
    { field: "walletAddress", overrides: { walletAddress: "not-an-address" } },
    { field: "serviceEndpoint", overrides: { serviceEndpoint: "not-a-url" } },
    { field: "credentialSecret", overrides: { credentialSecret: "" } },
    { field: "email", overrides: { email: "" } },
    { field: "email", overrides: { email: "not-an-email" } },
  ];

  for (const { field, overrides } of REQUIRED_FIELD_CASES) {
    it(`rejects creation with 422 VALIDATION_FAILED when "${field}" is missing/invalid (${JSON.stringify(overrides)})`, async () => {
      const deps = makeCreateDeps();
      const body = validCreateBody(overrides);

      await expect(createAgent(body, "idem-key-1", WALLET_ADDRESS, deps)).rejects.toMatchObject({
        httpStatus: 422,
        body: { error_code: "VALIDATION_FAILED" },
      });
      expect((deps.repository as InMemoryCreateAgentRepository).rows).toHaveLength(0);
    });
  }

  it("rejects creation when email is entirely absent from the request body", async () => {
    const deps = makeCreateDeps();
    const body = validCreateBody();
    delete (body as Record<string, unknown>).email;

    let caught: unknown;
    try {
      await createAgent(body, "idem-key-2", WALLET_ADDRESS, deps);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.httpStatus).toBe(422);
    expect(apiError.body.fields?.some((f) => f.field === "email")).toBe(true);
    expect((deps.repository as InMemoryCreateAgentRepository).rows).toHaveLength(0);
  });

  it("rejects creation when tags is entirely absent from the request body", async () => {
    const deps = makeCreateDeps();
    const body = validCreateBody();
    delete body.tags;

    await expect(createAgent(body, "idem-key-tags", WALLET_ADDRESS, deps)).rejects.toMatchObject({
      httpStatus: 422,
      body: { error_code: "VALIDATION_FAILED" },
    });
    expect((deps.repository as InMemoryCreateAgentRepository).rows).toHaveLength(0);
  });

  it("accepts a fully valid submission and persists the row", async () => {
    const deps = makeCreateDeps();
    const result = await createAgent(validCreateBody(), "idem-key-3", WALLET_ADDRESS, deps);

    expect(result.statusCode).toBe(201);
    expect((deps.repository as InMemoryCreateAgentRepository).rows).toHaveLength(1);
  });
});

describe("Agent 注册集成流程：凭证不可明文读取", () => {
  it("never persists the plaintext credentialSecret anywhere in the stored row", async () => {
    const deps = makeCreateDeps();
    const plaintext = "super-secret-api-key-do-not-leak";

    await createAgent(validCreateBody({ credentialSecret: plaintext }), "idem-key-4", WALLET_ADDRESS, deps);

    const [row] = (deps.repository as InMemoryCreateAgentRepository).rows;
    if (!row) {
      throw new Error("expected a persisted row");
    }
    expect(row.encryptedSecret).not.toBe(plaintext);
    expect(row.encryptedSecret).not.toContain(plaintext);
    // 落库内容应是不透明的 base64 密文包（EnvelopeEncryptor 打包格式），不是可逆的原样编码。
    expect(Buffer.from(row.encryptedSecret, "base64").length).toBeGreaterThan(plaintext.length);
  });

  it("does not include the plaintext or ciphertext secret in the HTTP response body", async () => {
    const deps = makeCreateDeps();
    const plaintext = "another-secret-value";

    const result = await createAgent(validCreateBody({ credentialSecret: plaintext }), "idem-key-5", WALLET_ADDRESS, deps);

    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain(plaintext);
    expect(Object.keys(result.body as Record<string, unknown>).sort()).toEqual(["agentId", "status"]);
  });
});

describe("Agent 注册集成流程：审计日志写入", () => {
  it("writes an audit_logs entry for a successful creation, without leaking the credential", async () => {
    const auditLogWriter = new InMemoryAuditLogWriter();
    const deps = makeCreateDeps({ auditLogWriter });
    const plaintext = "creation-audit-secret";

    const result = await createAgent(
      validCreateBody({ credentialSecret: plaintext }),
      "idem-key-audit-1",
      WALLET_ADDRESS,
      deps,
    );
    const createdAgentId = (result.body as { agentId: string }).agentId;

    expect(auditLogWriter.entries).toHaveLength(1);
    expect(auditLogWriter.entries[0]).toMatchObject({
      actorId: WALLET_ADDRESS,
      actorType: "provider",
      action: "agent.create",
      targetType: "agent",
      targetId: createdAgentId,
      afterSummary: { agentId: createdAgentId, status: "pending_review" },
    });
    const serializedAudit = JSON.stringify(auditLogWriter.entries[0]);
    expect(serializedAudit).not.toContain(plaintext);
  });

  it("does not write a second audit entry when a duplicate submission replays the cached response", async () => {
    const auditLogWriter = new InMemoryAuditLogWriter();
    const deps = makeCreateDeps({ auditLogWriter });
    const body = validCreateBody();

    await createAgent(body, "idem-key-audit-2", WALLET_ADDRESS, deps);
    await createAgent(body, "idem-key-audit-2", WALLET_ADDRESS, deps);

    expect(auditLogWriter.entries).toHaveLength(1);
  });
});

function makeAgentRecord(overrides?: Partial<Agent>): Agent {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    providerWalletAddress: WALLET_ADDRESS,
    name: "Some Agent",
    categoryId: "11111111-1111-1111-1111-111111111111",
    capabilityDesc: "does things",
    tags: ["tag-a"],
    pricingType: "fixed",
    priceAmount: 1000n,
    priceCurrency: "USDC",
    serviceEndpoint: "https://agent.example.com",
    email: "provider@example.com",
    status: "active",
    pauseReason: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

/** 忠实复刻 `agents` 表：applyPatch 原地更新并回读，findById 从同一份存储读取。 */
class InMemoryAgentProfileRepository implements AgentRepository {
  private readonly byId = new Map<string, Agent>();

  constructor(seed: Agent) {
    this.byId.set(seed.id, seed);
  }

  async findById(agentId: string): Promise<Agent | null> {
    return this.byId.get(agentId) ?? null;
  }

  async applyPatch(agentId: string, patch: AgentPatch): Promise<Agent> {
    const existing = this.byId.get(agentId);
    if (!existing) {
      throw new Error("not found");
    }
    const updated: Agent = { ...existing, ...patch, updatedAt: new Date() };
    this.byId.set(agentId, updated);
    return updated;
  }
}

/** 忠实复刻 `agent_credentials` 表的覆盖写语义：不存在则 key_version=1，存在则递增。 */
class InMemoryAgentCredentialStore implements AgentCredentialStore {
  private readonly byAgentId = new Map<string, { encryptedSecret: string; keyVersion: number }>();

  async replace(agentId: string, encryptedSecret: string) {
    const existing = this.byAgentId.get(agentId);
    const keyVersion = existing ? existing.keyVersion + 1 : 1;
    this.byAgentId.set(agentId, { encryptedSecret, keyVersion });
    return { keyVersion, wasConfigured: existing !== undefined };
  }

  get(agentId: string) {
    return this.byAgentId.get(agentId);
  }
}

describe("Agent 编辑集成流程：审计日志写入", () => {
  it("writes an audit_logs entry reflecting only the changed fields after a successful PATCH", async () => {
    const agent = makeAgentRecord();
    const repository = new InMemoryAgentProfileRepository(agent);
    const auditLogWriter = new InMemoryAuditLogWriter();

    const updated = await patchAgent(
      { agentRepository: repository, auditLogWriter },
      { agentId: agent.id, actorId: agent.providerWalletAddress, rawBody: { name: "Renamed Agent" } },
    );

    expect(updated.name).toBe("Renamed Agent");
    expect(auditLogWriter.entries).toHaveLength(1);
    expect(auditLogWriter.entries[0]).toMatchObject({
      actorId: agent.providerWalletAddress,
      actorType: "provider",
      action: "agent.update",
      targetType: "agent",
      targetId: agent.id,
      beforeSummary: { name: "Some Agent" },
      afterSummary: { name: "Renamed Agent" },
    });
  });

  it("does not write an audit entry when the patch changes nothing", async () => {
    const agent = makeAgentRecord();
    const repository = new InMemoryAgentProfileRepository(agent);
    const auditLogWriter = new InMemoryAuditLogWriter();

    await patchAgent(
      { agentRepository: repository, auditLogWriter },
      { agentId: agent.id, actorId: agent.providerWalletAddress, rawBody: {} },
    );

    expect(auditLogWriter.entries).toHaveLength(0);
  });
});

describe("凭证替换集成流程：审计日志写入 + 不可明文读取", () => {
  function makeCredentialDeps(agent: Agent) {
    const agentRepository = new InMemoryAgentProfileRepository(agent);
    const credentialStore = new InMemoryAgentCredentialStore();
    const auditLogWriter = new InMemoryAuditLogWriter();
    const encryptor = makeEncryptor();
    const credentialEncryptor: CredentialEncryptor = {
      encryptCredential: (plaintext: string) => encryptor.encryptCredential(plaintext),
    };
    return { agentRepository, credentialStore, auditLogWriter, credentialEncryptor };
  }

  it("stores only ciphertext and writes an audit entry that never contains the secret", async () => {
    const agent = makeAgentRecord();
    const deps = makeCredentialDeps(agent);
    const plaintext = "brand-new-credential-secret";

    const result = await replaceAgentCredentials(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: { credentialSecret: plaintext },
    });

    expect(result).toEqual({ keyVersion: 1, configured: true });

    const stored = deps.credentialStore.get(agent.id);
    expect(stored?.encryptedSecret).toBeDefined();
    expect(stored!.encryptedSecret).not.toContain(plaintext);

    expect(deps.auditLogWriter.entries).toHaveLength(1);
    const auditEntry = deps.auditLogWriter.entries[0];
    expect(auditEntry).toMatchObject({
      actorId: agent.providerWalletAddress,
      action: "agent.credentials.replace",
      targetType: "agent",
      targetId: agent.id,
      afterSummary: { configured: true, keyVersion: 1 },
    });
    const serializedAudit = JSON.stringify(auditEntry);
    expect(serializedAudit).not.toContain(plaintext);
    expect(serializedAudit).not.toContain(stored!.encryptedSecret);
  });

  it("increments key_version and marks wasConfigured=true on a second replace", async () => {
    const agent = makeAgentRecord();
    const deps = makeCredentialDeps(agent);

    await replaceAgentCredentials(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: { credentialSecret: "first-secret" },
    });
    const second = await replaceAgentCredentials(deps, {
      agentId: agent.id,
      actorId: agent.providerWalletAddress,
      rawBody: { credentialSecret: "second-secret" },
    });

    expect(second).toEqual({ keyVersion: 2, configured: true });
    expect(deps.auditLogWriter.entries).toHaveLength(2);
    expect(deps.auditLogWriter.entries[1]?.beforeSummary).toEqual({ configured: true });
  });

  it("rejects replacing credentials for an agent owned by a different wallet", async () => {
    const agent = makeAgentRecord({ providerWalletAddress: WALLET_ADDRESS });
    const deps = makeCredentialDeps(agent);

    await expect(
      replaceAgentCredentials(deps, {
        agentId: agent.id,
        actorId: "0x0000000000000000000000000000000000dEaD",
        rawBody: { credentialSecret: "attacker-supplied-secret" },
      }),
    ).rejects.toMatchObject({ code: "AGENT_ACCESS_DENIED" });

    expect(deps.credentialStore.get(agent.id)).toBeUndefined();
    expect(deps.auditLogWriter.entries).toHaveLength(0);
  });
});

describe("Agent 注册集成流程：重复提交幂等", () => {
  it("replays the exact same response on a duplicate submission without writing a second row", async () => {
    const store = new InMemoryIdempotencyStore();
    const repository = new InMemoryCreateAgentRepository();
    const deps = { repository, encryptor: makeEncryptor(), idempotency: new Idempotency(store), auditLogWriter: new InMemoryAuditLogWriter() };
    const body = validCreateBody();

    const first = await createAgent(body, "idem-key-dup", WALLET_ADDRESS, deps);
    const second = await createAgent(body, "idem-key-dup", WALLET_ADDRESS, deps);

    expect(second).toEqual(first);
    expect(repository.rows).toHaveLength(1);
  });

  it("rejects a concurrent duplicate (same key, prior request still pending) with a retryable 409", async () => {
    const store = new InMemoryIdempotencyStore();
    // 手动占位一个 pending 记录，模拟"上一个请求正在处理中、尚未 commit"的并发场景
    // （PgIdempotencyStore.reserve 对 pending key 的真实返回语义）。
    await store.reserve("idem-key-inflight", "agent.create", new Date(Date.now() + 60_000));

    const repository = new InMemoryCreateAgentRepository();
    const deps = { repository, encryptor: makeEncryptor(), idempotency: new Idempotency(store), auditLogWriter: new InMemoryAuditLogWriter() };

    await expect(createAgent(validCreateBody(), "idem-key-inflight", WALLET_ADDRESS, deps)).rejects.toMatchObject({
      httpStatus: 409,
      body: { error_code: "IDEMPOTENCY_REQUEST_IN_PROGRESS", retryable: true },
    });
    expect(repository.rows).toHaveLength(0);
  });

  it("treats a missing Idempotency-Key as a hard validation error before touching the repository", async () => {
    const deps = makeCreateDeps();

    await expect(createAgent(validCreateBody(), undefined, WALLET_ADDRESS, deps)).rejects.toMatchObject({
      httpStatus: 400,
      body: { error_code: "IDEMPOTENCY_KEY_MISSING" },
    });
    expect((deps.repository as InMemoryCreateAgentRepository).rows).toHaveLength(0);
  });

  it("executes the business logic exactly once per distinct idempotency key even when submitted twice each", async () => {
    const store = new InMemoryIdempotencyStore();
    const repository = new InMemoryCreateAgentRepository();
    const deps = { repository, encryptor: makeEncryptor(), idempotency: new Idempotency(store), auditLogWriter: new InMemoryAuditLogWriter() };

    await createAgent(validCreateBody({ name: "Agent A" }), "key-a", WALLET_ADDRESS, deps);
    await createAgent(validCreateBody({ name: "Agent A" }), "key-a", WALLET_ADDRESS, deps);
    await createAgent(validCreateBody({ name: "Agent B" }), "key-b", WALLET_ADDRESS, deps);

    expect(repository.rows).toHaveLength(2);
  });
});
