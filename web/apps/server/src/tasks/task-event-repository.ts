import type { QueryExecutor } from "../db/pool";

export type TaskEventToEmit = Readonly<{
	taskId: string;
	statusVersion: bigint;
	eventType: string;
	payload: Readonly<Record<string, unknown>>;
	createdAt: Date;
}>;

export type StoredTaskEvent = Readonly<{
	id: string;
	taskId: string;
	statusVersion: string;
	eventType: string;
	payload: Readonly<Record<string, unknown>>;
	createdAt: Date;
}>;

export type WebhookDeadLetterView = Readonly<{
	deliveryId: string;
	taskId: string;
	taskEventId: string;
	agentId: string;
	endpoint: string;
	attemptNo: number;
	lastErrorCode: string | null;
	failedAt: Date;
}>;

type EventRow = {
	id: string;
	task_id: string;
	status_version: string;
	event_type: string;
	payload: Record<string, unknown>;
	created_at: Date;
};

type DeadLetterRow = {
	id: string;
	task_id: string;
	task_event_id: string;
	agent_id: string;
	endpoint: string;
	attempt_no: number;
	last_error_code: string | null;
	updated_at: Date;
};

/**
 * 会改变 Agent 信誉输入的任务事件。名单集中在事件仓储边界，业务写入口只需正确记录
 * 权威事件，不必各自了解刷新队列表结构。周期性全量重算仍会修复漏发和时间衰减漂移。
 */
const SCORE_REFRESH_EVENT_TYPES = [
	"agent_accepted",
	"task.rated",
	"task.workflow_feedback_submitted",
	"task.settlement_confirmed",
	"task.workflow_settlement_confirmed",
	"task.arbitration_release_confirmed",
	"task.arbitration_execution_confirmed",
	"task.arbitration_refund_confirmed",
] as const;

/**
 * 在调用方事务内同时写入权威任务事件、Webhook outbox 和必要的评分刷新请求。
 *
 * 收件人规则集中在这里：事件产生时选择该任务最近一次分配的 Agent，并冻结当时的
 * service_endpoint。任务尚未分配时（例如 task.submitted）只写事件，不创建空投递。
 * 这样所有状态变化入口都不会再各自决定“是否记得通知 Agent”。网络调用由 Go worker
 * 在事务提交后执行，外部端点失败不会回滚已经成立的任务事实。评分相关事件会为所有
 * 已接单 Agent 合并一条刷新请求，确保多 Agent 工作流结算后每个参与者都能及时更新。
 */
export async function emitTaskEvent(
	db: QueryExecutor,
	event: TaskEventToEmit,
): Promise<void> {
	await db.query(
		`WITH inserted_event AS (
       INSERT INTO task_events(task_id,status_version,event_type,payload,created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       RETURNING id
     ), recipient AS (
       SELECT assignment.agent_id
         FROM task_assignments assignment
        WHERE assignment.task_id=$1
        ORDER BY assignment.assigned_at DESC, assignment.id DESC
        LIMIT 1
     ), webhook_insert AS (
       INSERT INTO webhook_deliveries(
       task_event_id,agent_id,endpoint,idempotency_key,status,next_attempt_at
     )
     SELECT inserted_event.id,agent.id,
            regexp_replace(agent.service_endpoint, '/+$', '') || '/webhook',
            -- 协议固定为三段 {operation}:{taskId}:{clientGeneratedId}。事件 ID 与收件
            -- Agent ID 组合在第三段，既保留多收件人唯一性，也不依赖接收方截断解析。
            'webhook:' || $1::text || ':' || inserted_event.id::text || '-' || agent.id::text,
            'pending',$5
       FROM inserted_event
       JOIN recipient ON TRUE
       JOIN agents agent ON agent.id=recipient.agent_id
                         AND agent.integration_mode='aicp_hmac'
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING task_event_id
     )
     INSERT INTO agent_score_refresh_requests(agent_id,requested_at,reason_event_id)
     SELECT DISTINCT assignment.agent_id,$5,inserted_event.id
       FROM inserted_event
       JOIN task_assignments assignment
         ON assignment.task_id=$1 AND assignment.status='accepted'
      WHERE $3=ANY($6::text[])
     ON CONFLICT (agent_id) DO UPDATE
       SET requested_at=GREATEST(agent_score_refresh_requests.requested_at,EXCLUDED.requested_at),
           reason_event_id=CASE
             WHEN EXCLUDED.requested_at >= agent_score_refresh_requests.requested_at
             THEN EXCLUDED.reason_event_id
             ELSE agent_score_refresh_requests.reason_event_id
           END`,
		[
			event.taskId,
			event.statusVersion.toString(),
			event.eventType,
			JSON.stringify(event.payload),
			event.createdAt,
			SCORE_REFRESH_EVENT_TYPES,
		],
	);
}

/**
 * 向一个已经确定的 Agent 写入任务事件与 Webhook outbox。
 *
 * 正式多 Agent 工作流不能沿用“任务最近一次 assignment”推断收件人：返工的可能是
 * 任意历史节点，而任务最近分配的往往是另一个下游 Agent。调用方必须先在事务内锁定
 * 工作流节点并解析其当前 assignment，再把明确的 Agent ID 传入这里。事件、投递和
 * 必要的评分刷新请求仍在同一事务落库，因此接口成功就意味着异步副作用具备恢复依据。
 * HMAC Agent 接收 `/webhook` 事件；HTTP JSON Agent 的定向返工则复用同一 outbox，
 * 由分发引擎把数据库重建的 dispatch.v1 发送到原 `/run` 端点并回传快速结果。
 */
export async function emitTaskEventToAgent(
	db: QueryExecutor,
	event: TaskEventToEmit,
	agentId: string,
): Promise<void> {
	await db.query(
		`WITH inserted_event AS (
       INSERT INTO task_events(task_id,status_version,event_type,payload,created_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)
       RETURNING id
     ), webhook_insert AS (
       INSERT INTO webhook_deliveries(
       task_event_id,agent_id,endpoint,idempotency_key,status,next_attempt_at
     )
     SELECT inserted_event.id,agent.id,
            CASE WHEN agent.integration_mode='aicp_hmac'
                 THEN regexp_replace(agent.service_endpoint, '/+$', '') || '/webhook'
                 ELSE agent.service_endpoint END,
            'webhook:' || $1::text || ':' || inserted_event.id::text || '-' || agent.id::text,
            'pending',$5
       FROM inserted_event
       JOIN agents agent ON agent.id=$6
                         AND agent.integration_mode IN ('aicp_hmac','http_json')
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING task_event_id
     )
     INSERT INTO agent_score_refresh_requests(agent_id,requested_at,reason_event_id)
     SELECT $6::uuid,$5,inserted_event.id
       FROM inserted_event
      WHERE $3=ANY($7::text[])
     ON CONFLICT (agent_id) DO UPDATE
       SET requested_at=GREATEST(agent_score_refresh_requests.requested_at,EXCLUDED.requested_at),
           reason_event_id=CASE
             WHEN EXCLUDED.requested_at >= agent_score_refresh_requests.requested_at
             THEN EXCLUDED.reason_event_id
             ELSE agent_score_refresh_requests.reason_event_id
           END`,
		[
			event.taskId,
			event.statusVersion.toString(),
			event.eventType,
			JSON.stringify(event.payload),
			event.createdAt,
			agentId,
			SCORE_REFRESH_EVENT_TYPES,
		],
	);
}

export class PgTaskEventReader {
	constructor(private readonly db: QueryExecutor) {}

	async canRead(taskId: string, actorId: string): Promise<boolean> {
		const result = await this.db.query(
			"SELECT 1 FROM tasks WHERE id=$1 AND lower(publisher_id)=lower($2) AND archived_at IS NULL",
			[taskId, actorId],
		);
		return result.rows[0] !== undefined;
	}

	/**
	 * SSE cursor 使用 task_events 全局 BIGSERIAL id；status_version 则是任务聚合的单调
	 * 版本。即使事件不改变 status 字段（例如提交争议证据），写入方也必须先递增任务
	 * 版本，因此 `(task_id,status_version)` 仍能承担跨进程去重约束。
	 */
	async after(
		taskId: string,
		lastEventId: bigint,
		limit: number,
	): Promise<readonly StoredTaskEvent[]> {
		const result = await this.db.query<EventRow>(
			`SELECT id::text,task_id::text,status_version::text,event_type,payload,created_at
         FROM task_events WHERE task_id=$1 AND id>$2 ORDER BY id LIMIT $3`,
			[taskId, lastEventId.toString(), limit],
		);
		return result.rows.map((row) => ({
			id: row.id,
			taskId: row.task_id,
			statusVersion: row.status_version,
			eventType: row.event_type,
			payload: row.payload,
			createdAt: row.created_at,
		}));
	}

	/**
	 * 运营查询只返回端点 origin，路径、查询参数和可能包含的内部租户标识始终被遮蔽。
	 * taskId 为空时读取全局最近死信；该入口只会被内部 token 保护的 handler 调用。
	 */
	async deadLetters(
		taskId: string | null,
		limit: number,
	): Promise<readonly WebhookDeadLetterView[]> {
		const result = await this.db.query<DeadLetterRow>(
			`SELECT delivery.id::text,event.task_id::text,delivery.task_event_id::text,
              delivery.agent_id::text,delivery.endpoint,delivery.attempt_no,
              delivery.last_error_code,delivery.updated_at
         FROM webhook_deliveries delivery
         JOIN task_events event ON event.id=delivery.task_event_id
        WHERE delivery.status='dead_letter' AND ($1::uuid IS NULL OR event.task_id=$1)
        ORDER BY delivery.updated_at DESC,delivery.id
        LIMIT $2`,
			[taskId, limit],
		);
		return result.rows.map((row) => ({
			deliveryId: row.id,
			taskId: row.task_id,
			taskEventId: row.task_event_id,
			agentId: row.agent_id,
			endpoint: maskEndpoint(row.endpoint),
			attemptNo: row.attempt_no,
			lastErrorCode: row.last_error_code,
			failedAt: row.updated_at,
		}));
	}
}

function maskEndpoint(endpoint: string): string {
	try {
		const parsed = new URL(endpoint);
		return parsed.protocol === "http:" || parsed.protocol === "https:"
			? `${parsed.origin}/…`
			: "invalid-endpoint";
	} catch {
		return "invalid-endpoint";
	}
}
