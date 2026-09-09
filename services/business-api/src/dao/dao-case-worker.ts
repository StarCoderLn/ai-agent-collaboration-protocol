import { z } from "zod";

import type { PoolLike, QueryExecutor } from "../db/pool";
import { withTransaction } from "../db/pool";
import type { PreparedOperatorTransaction } from "../escrow/escrow-operator-client";
import type { DaoCaseChainClient } from "./dao-case-chain-client";
import { daoCaseInterface } from "./dao-case-contract";
import { candidatesForSnapshot, parseCandidatePoolSnapshot } from "./dao-candidate-pool";
import { enqueueCaseCommand, nextCaseAction, projectChainCase } from "./dao-chain-case-repository";

/** 签名和广播分离，成功签名后必须先存数据库；外部签名器未来可替换而不改变案件状态机。 */
export interface DaoCaseOperator {
  prepareContractCall(to: string, data: string): Promise<PreparedOperatorTransaction>;
  broadcast(transaction: PreparedOperatorTransaction): Promise<string>;
  receipt(txHash: string): Promise<"pending" | "confirmed" | "reverted">;
}

/**
 * 独立案件后台推进器。没有候选、VRF 未返回、奖励不足均保持冻结并记录可诊断原因；
 * 不重新抽签、不替当事人付款、不把超时当退款。数据库持久化命令覆盖进程重启恢复。
 */
export class DaoCaseWorker {
  constructor(private readonly pool: PoolLike, private readonly chain: DaoCaseChainClient, private readonly operator: DaoCaseOperator) {}

  async run(limit = 10): Promise<Readonly<{ synchronized: number; submitted: number; failed: number }>> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("INVALID_DAO_WORKER_LIMIT");
    const rows = await withTransaction(this.pool, (db) => db.query<{
      dispute_id: string; case_key: string; parties: unknown; candidate_pool_policy: unknown;
    }>(
      `SELECT chain.dispute_id::text,chain.case_key,chain.parties,chain.candidate_pool_policy
       FROM dao_chain_cases chain JOIN disputes dispute ON dispute.id=chain.dispute_id
       WHERE chain.chain_id=$1 AND chain.contract_address=$2 AND (chain.status<>'final' OR dispute.status<>'executed')
       ORDER BY chain.updated_at,chain.dispute_id LIMIT $3`,
      [this.chain.chainId.toString(), this.chain.contractAddress, limit],
    ));
    let synchronized = 0;
    let failed = 0;
    let chainReadFailed = false;
    const blockedCases = new Set<string>();
    for (const row of rows.rows) {
      let snapshotRead = false;
      try {
        const snapshot = await this.chain.read(row.case_key);
        snapshotRead = true;
        const action = nextCaseAction(snapshot);
        let candidates: readonly string[] = [];
        if (action === "requestPanel") {
          const parties = z.array(z.string()).parse(row.parties);
          const excluded = [...parties, ...(snapshot.round === 2 ? snapshot.firstPanel : [])];
          const policy = parseCandidatePoolSnapshot(row.candidate_pool_policy);
          const members = await withTransaction(this.pool, (db) => db.query<{ actor_id: string }>(
            `SELECT actor_id FROM dao_memberships WHERE chain_id=$1 AND eligible=TRUE
             AND NOT (actor_id=ANY($2::text[])) ORDER BY actor_id LIMIT 257`, [this.chain.chainId.toString(), excluded],
          ));
          const stored = members.rows.map((member) => member.actor_id);
          // 社区阶段不再把创始成员发送给链节点；启动/混合阶段先复核全部可能候选，
          // 再按案件固化策略筛选，避免数据库中过期的 eligible 标记进入 VRF 承诺。
          const eligibilityInput = policy.phase === "community" ? candidatesForSnapshot(policy, stored) : stored;
          candidates = candidatesForSnapshot(policy, await this.chain.eligibleMembers(eligibilityInput));
        }
        await withTransaction(this.pool, async (db) => {
          await projectChainCase(db, row.dispute_id, snapshot, this.chain, new Date());
          if (action === null) return;
          if (action === "requestPanel" && candidates.length < (snapshot.round === 1 ? 3 : 5)) {
            await db.query("UPDATE dao_chain_cases SET last_error_code='DAO_PANEL_INSUFFICIENT' WHERE dispute_id=$1", [row.dispute_id]);
            return;
          }
          await enqueueCaseCommand(db, row.dispute_id, `${snapshot.round}:${action}`,
            daoCaseInterface.encodeFunctionData(action, action === "requestPanel" ? [row.case_key, candidates] : [row.case_key]));
        });
        synchronized++;
      } catch (error) {
        failed++;
        blockedCases.add(row.dispute_id);
        chainReadFailed ||= !snapshotRead;
        await withTransaction(this.pool, (db) => markFailure(db, row.dispute_id, safeErrorCode(error)));
      }
    }
    // 同一 operator 共用 nonce。确认快照不可用时，本轮不能在旧状态上继续签名或重播；
    // 下一轮重新读链成功后自动恢复，已持久化的签名和命令保持原样。
    const submitted = chainReadFailed ? 0 : await this.advanceCommands(limit, blockedCases);
    return { synchronized, submitted, failed };
  }

  /**
   * 专用 operator 的跨进程 advisory lock 序列化 nonce：签名、持久化、广播按三个短事务
   * 阶段执行。锁跨越这三个阶段但原始签名先提交，广播响应丢失只会重发同一交易。
   */
  private async advanceCommands(limit: number, blockedCases: ReadonlySet<string>): Promise<number> {
    const connection = await this.pool.connect();
    const lockKey = `aicp:dao-case-operator:${this.chain.chainId}`;
    let locked = false;
    let submitted = 0;
    try {
      const result = await connection.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked", [lockKey]);
      locked = result.rows[0]?.locked === true;
      if (!locked) return 0;
      const commands = await connection.query<CommandRow>(
        `SELECT command.id::text,command.dispute_id::text,command.calldata,command.status,command.tx_hash,command.raw_transaction,
         (SELECT count(*)::text FROM dao_case_command_attempts attempt WHERE attempt.command_id=command.id) AS attempts,
         EXISTS(SELECT 1 FROM reconciliation_alerts alert JOIN disputes dispute ON dispute.task_id=alert.task_id
           WHERE dispute.id=chain.dispute_id AND alert.resolved_at IS NULL AND alert.operations_frozen=TRUE) AS operations_frozen
         FROM dao_case_commands command JOIN dao_chain_cases chain ON chain.dispute_id=command.dispute_id
         WHERE chain.chain_id=$1 AND chain.contract_address=$2 AND command.status IN ('pending','prepared','submitted')
         ORDER BY command.created_at,command.id LIMIT $3`, [this.chain.chainId.toString(), this.chain.contractAddress, limit],
      );
      for (const command of commands.rows) {
        // 对账冻结持续到受控恢复显式解决，不能因下一次 RPC 成功而自动消失；也不能越过
        // 可能持有未确认 nonce 的冻结命令继续发后续交易。这里保留原始签名供后续核对。
        if (command.operations_frozen) break;
        try {
          if (command.tx_hash !== null) {
            const receipt = await this.operator.receipt(command.tx_hash);
            if (receipt !== "pending") {
              await recordCommandReceipt(connection, command, receipt);
              if (receipt === "reverted") await markFailure(connection, command.dispute_id, "DAO_COMMAND_REVERTED");
              continue;
            }
          }
          // 单案候选错误不妨碍只读确认先前已广播的开案交易；回执收敛后可以处理其他
          // 案件。只有仍未知的已签名 nonce 必须停在原处；未签名失败则让出队列。
          if (blockedCases.has(command.dispute_id)) {
            if (command.raw_transaction !== null) break;
            continue;
          }
          let prepared: PreparedOperatorTransaction;
          if (command.raw_transaction !== null && command.tx_hash !== null) {
            prepared = { rawTransaction: command.raw_transaction, txHash: command.tx_hash };
          } else {
            if (Number(command.attempts) >= 5) throw new Error("DAO_COMMAND_ATTEMPTS_EXHAUSTED");
            prepared = await this.operator.prepareContractCall(this.chain.contractAddress, command.calldata);
            // 新签名与当前指针必须在同一短事务提交后才能广播；历史尝试只追加、不覆盖。
            await persistPreparedAttempt(connection, command, prepared);
          }
          const hash = await this.operator.broadcast(prepared);
          if (hash.toLowerCase() !== prepared.txHash.toLowerCase()) throw new Error("DAO_BROADCAST_HASH_MISMATCH");
          await recordCommandSubmitted(connection, command.id, prepared.txHash);
          submitted++;
          // 未确认交易保留原始签名继续恢复；一次只广播一个 nonce，不积压未知状态的后续调用。
          break;
        } catch (error) {
          await markFailure(connection, command.dispute_id, safeErrorCode(error));
          // 预执行失败没有广播，不作无限快速重试；保留显式失败供运营在排除原因后重新入队。
          if (command.tx_hash === null) await connection.query(
            "UPDATE dao_case_commands SET status=CASE WHEN tx_hash IS NULL THEN 'failed' ELSE status END,error_code=$2,updated_at=now() WHERE id=$1",
            [command.id, safeErrorCode(error)]);
          break;
        }
      }
    } finally {
      try {
        if (locked) await connection.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [lockKey]);
      } finally { connection.release(); }
    }
    return submitted;
  }
}

type CommandRow = {
  id: string; dispute_id: string; calldata: string; status: string; tx_hash: string | null;
  raw_transaction: string | null; attempts: string; operations_frozen: boolean;
};

async function persistPreparedAttempt(
  db: QueryExecutor, command: CommandRow, prepared: PreparedOperatorTransaction,
): Promise<void> {
  const attemptNo = Number(command.attempts) + 1;
  if (!Number.isSafeInteger(attemptNo) || attemptNo < 1 || attemptNo > 5) throw new Error("DAO_COMMAND_ATTEMPTS_EXHAUSTED");
  await db.query("BEGIN", []);
  try {
    await db.query(
      `INSERT INTO dao_case_command_attempts(command_id,attempt_no,raw_transaction,tx_hash,status)
       VALUES($1,$2,$3,$4,'prepared')`,
      [command.id, attemptNo, prepared.rawTransaction, prepared.txHash.toLowerCase()],
    );
    await db.query(
      "UPDATE dao_case_commands SET status='prepared',tx_hash=$2,raw_transaction=$3,error_code=NULL,updated_at=now() WHERE id=$1",
      [command.id, prepared.txHash.toLowerCase(), prepared.rawTransaction],
    );
    await db.query("COMMIT", []);
  } catch (error) {
    await db.query("ROLLBACK", []);
    throw error;
  }
}

async function recordCommandSubmitted(db: QueryExecutor, commandId: string, txHash: string): Promise<void> {
  await db.query("BEGIN", []);
  try {
    const attempt = await db.query(
      "UPDATE dao_case_command_attempts SET status='submitted',error_code=NULL,updated_at=now() WHERE command_id=$1 AND tx_hash=$2 AND status IN ('prepared','submitted')",
      [commandId, txHash.toLowerCase()],
    );
    if (attempt.rowCount !== 1) throw new Error("DAO_COMMAND_ATTEMPT_MISSING");
    await db.query("UPDATE dao_case_commands SET status='submitted',error_code=NULL,updated_at=now() WHERE id=$1", [commandId]);
    await db.query("COMMIT", []);
  } catch (error) {
    await db.query("ROLLBACK", []);
    throw error;
  }
}

async function recordCommandReceipt(
  db: QueryExecutor, command: CommandRow, receipt: "confirmed" | "reverted",
): Promise<void> {
  if (command.tx_hash === null) throw new Error("DAO_COMMAND_ATTEMPT_MISSING");
  const errorCode = receipt === "reverted" ? "DAO_COMMAND_REVERTED" : null;
  await db.query("BEGIN", []);
  try {
    const attempt = await db.query(
      "UPDATE dao_case_command_attempts SET status=$3,error_code=$4,updated_at=now() WHERE command_id=$1 AND tx_hash=$2 AND status IN ('prepared','submitted')",
      [command.id, command.tx_hash, receipt, errorCode],
    );
    if (attempt.rowCount !== 1) throw new Error("DAO_COMMAND_ATTEMPT_MISSING");
    await db.query(
      "UPDATE dao_case_commands SET status=$2,error_code=$3,updated_at=now() WHERE id=$1",
      [command.id, receipt === "confirmed" ? "confirmed" : "failed", errorCode],
    );
    await db.query("COMMIT", []);
  } catch (error) {
    await db.query("ROLLBACK", []);
    throw error;
  }
}

/** 只写稳定错误码，不把 RPC 错误中的 calldata、完整证据或供应商凭据带入日志。 */
function safeErrorCode(error: unknown): string {
  return error instanceof Error && /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message) ? error.message : "DAO_CASE_SYNC_FAILED";
}
async function markFailure(db: QueryExecutor, disputeId: string, code: string): Promise<void> {
  await db.query("UPDATE dao_chain_cases SET last_error_code=$2,updated_at=now() WHERE dispute_id=$1", [disputeId, code]);
  if (code === "DAO_FINAL_DECISION_REORGED") {
    await db.query(
      `INSERT INTO reconciliation_alerts(task_id,discrepancy_summary,operations_frozen)
       SELECT task_id,$2::jsonb,TRUE FROM disputes WHERE id=$1
       ON CONFLICT (task_id) WHERE resolved_at IS NULL
       DO UPDATE SET discrepancy_summary=EXCLUDED.discrepancy_summary,operations_frozen=TRUE`,
      [disputeId, JSON.stringify({ code, disputeId })],
    );
  }
}
