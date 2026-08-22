/**
 * SIWE 会话存储（2.agent-registration T-010）。
 *
 * 权威表结构见 services/business-service/migrations/0002_auth_nonces_and_sessions.up.sql；
 * 权威设计见 specs/2.agent-registration/design.md 「模块 5」。`session_id` 直接是
 * Cookie 承载的不透明值（不是自解释 JWT），服务端必须持有本表才能校验/吊销。
 * 会话 TTL 24 小时（design.md 模块 5），过期后要求重新走一遍 SIWE 流程。
 */

import { randomBytes } from "node:crypto";
import type { QueryExecutor } from "../db/pool";

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SESSION_ID_BYTES = 32;

export interface SessionRecord {
  sessionId: string;
  walletAddress: string;
  expiresAt: Date;
}

export interface SessionStore {
  /** 为 `walletAddress` 签发一个新会话并持久化。 */
  create(walletAddress: string): Promise<SessionRecord>;
  /** 返回未过期的会话，不存在或已过期时返回 null（调用方视为未认证）。 */
  findValid(sessionId: string): Promise<SessionRecord | null>;
}

interface SessionRow {
  session_id: string;
  wallet_address: string;
  expires_at: Date;
}

export class PgSessionStore implements SessionStore {
  constructor(
    private readonly db: QueryExecutor,
    private readonly ttlMs: number = DEFAULT_SESSION_TTL_MS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(walletAddress: string): Promise<SessionRecord> {
    const sessionId = randomBytes(SESSION_ID_BYTES).toString("hex");
    const expiresAt = new Date(this.now().getTime() + this.ttlMs);
    await this.db.query(
      `INSERT INTO auth_sessions (session_id, wallet_address, expires_at) VALUES ($1, $2, $3)`,
      [sessionId, walletAddress, expiresAt],
    );
    return { sessionId, walletAddress, expiresAt };
  }

  async findValid(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.db.query<SessionRow>(
      `SELECT session_id, wallet_address, expires_at
       FROM auth_sessions
       WHERE session_id = $1 AND expires_at > now()`,
      [sessionId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return { sessionId: row.session_id, walletAddress: row.wallet_address, expiresAt: row.expires_at };
  }
}
