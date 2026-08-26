export type TaskEventPayload = Readonly<Record<string, unknown>>;

export type TaskEvent = Readonly<{
  id: string;
  taskId: string;
  eventType: string;
  statusVersion: bigint;
  payload: TaskEventPayload;
  createdAt: Date;
}>;

/**
 * task_events 的内存领域模型。SSE 与 Webhook 都读取同一份事件，不各自维护队列；
 * 生产仓储用 `(task_id, status_version)` 唯一约束提供跨进程的相同保证。
 */
export class TaskEventLog {
  readonly #eventsByTask = new Map<string, TaskEvent[]>();

  emit(taskId: string, eventType: string, payload: TaskEventPayload, createdAt: Date): TaskEvent {
    if (taskId.length === 0 || eventType.length === 0 || Number.isNaN(createdAt.getTime())) {
      throw new Error("INVALID_TASK_EVENT");
    }
    const events = this.#eventsByTask.get(taskId) ?? [];
    const statusVersion = BigInt(events.length + 1);
    const event: TaskEvent = {
      id: statusVersion.toString(),
      taskId,
      eventType,
      statusVersion,
      payload,
      createdAt,
    };
    events.push(event);
    this.#eventsByTask.set(taskId, events);
    return event;
  }

  /** Last-Event-ID 在单任务 SSE 流内就是 statusVersion，重连只返回严格更大的事件。 */
  after(taskId: string, lastEventId: string | null): readonly TaskEvent[] {
    const events = this.#eventsByTask.get(taskId) ?? [];
    if (lastEventId === null || lastEventId.length === 0) return [...events];
    if (!/^\d+$/.test(lastEventId)) throw new Error("INVALID_EVENT_CURSOR");
    const cursor = BigInt(lastEventId);
    return events.filter((event) => event.statusVersion > cursor);
  }

  latest(taskId: string): TaskEvent | null {
    const events = this.#eventsByTask.get(taskId) ?? [];
    return events.at(-1) ?? null;
  }
}

/** 接收方按事件 ID 去重；只有首次看到事件时才调用业务更新函数。 */
export class TaskEventConsumer {
  readonly #seen = new Set<string>();

  applyOnce(event: TaskEvent, apply: (event: TaskEvent) => void): boolean {
    const key = `${event.taskId}:${event.id}`;
    if (this.#seen.has(key)) return false;
    apply(event);
    this.#seen.add(key);
    return true;
  }
}

export type WebhookDeliveryStatus = "pending" | "delivered" | "retry_pending" | "dead_letter";
export type WebhookDelivery = Readonly<{
  idempotencyKey: string;
  taskId: string;
  taskEventId: string;
  endpoint: string;
  status: WebhookDeliveryStatus;
  attemptNo: number;
  lastErrorCode: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
}>;
export type WebhookRetryPolicy = Readonly<{ maxAttempts: number; baseDelayMs: number }>;

/**
 * WebhookDeliveryQueue 只管理“通知是否送达”，不持有也不回滚任务实体。业务状态先提交、
 * 再从 task_events 异步投递，所以网络失败不会把已经成立的任务进度倒退。
 */
export class WebhookDeliveryQueue {
  readonly #deliveries = new Map<string, WebhookDelivery>();

  enqueue(event: TaskEvent, endpoint: string): WebhookDelivery {
    if (!isHttpEndpoint(endpoint)) throw new Error("INVALID_WEBHOOK_ENDPOINT");
    const idempotencyKey = `webhook:${event.taskId}:${event.id}`;
    const existing = this.#deliveries.get(idempotencyKey);
    if (existing !== undefined) return existing;
    const delivery: WebhookDelivery = {
      idempotencyKey,
      taskId: event.taskId,
      taskEventId: event.id,
      endpoint,
      status: "pending",
      attemptNo: 0,
      lastErrorCode: null,
      nextAttemptAt: null,
      deliveredAt: null,
    };
    this.#deliveries.set(idempotencyKey, delivery);
    return delivery;
  }

  recordFailure(
    idempotencyKey: string,
    errorCode: string,
    retryable: boolean,
    now: Date,
    policy: WebhookRetryPolicy,
  ): WebhookDelivery {
    validateRetryPolicy(policy);
    const current = this.#required(idempotencyKey);
    if (current.status === "delivered" || current.status === "dead_letter") {
      return current;
    }
    const attemptNo = current.attemptNo + 1;
    const deadLetter = !retryable || attemptNo >= policy.maxAttempts;
    const next: WebhookDelivery = {
      ...current,
      status: deadLetter ? "dead_letter" : "retry_pending",
      attemptNo,
      lastErrorCode: errorCode,
      nextAttemptAt: deadLetter
        ? null
        : new Date(now.getTime() + policy.baseDelayMs * 2 ** Math.min(attemptNo - 1, 8)),
    };
    this.#deliveries.set(idempotencyKey, next);
    return next;
  }

  markDelivered(idempotencyKey: string, deliveredAt: Date): WebhookDelivery {
    const current = this.#required(idempotencyKey);
    if (current.status === "dead_letter") throw new Error("WEBHOOK_ALREADY_DEAD_LETTERED");
    const next: WebhookDelivery = {
      ...current,
      status: "delivered",
      deliveredAt,
      nextAttemptAt: null,
    };
    this.#deliveries.set(idempotencyKey, next);
    return next;
  }

  due(now: Date): readonly WebhookDelivery[] {
    return [...this.#deliveries.values()].filter((delivery) =>
      delivery.status === "pending"
      || (delivery.status === "retry_pending" && delivery.nextAttemptAt !== null && delivery.nextAttemptAt <= now));
  }

  deadLetters(taskId?: string): readonly WebhookDelivery[] {
    return [...this.#deliveries.values()].filter((delivery) =>
      delivery.status === "dead_letter" && (taskId === undefined || delivery.taskId === taskId));
  }

  /** 运营查询不暴露完整路径和查询参数，避免错误详情泄漏 Agent 的内部服务配置。 */
  operationalView(delivery: WebhookDelivery) {
    const url = new URL(delivery.endpoint);
    return {
      taskId: delivery.taskId,
      taskEventId: delivery.taskEventId,
      endpoint: `${url.origin}/…`,
      status: delivery.status,
      attemptNo: delivery.attemptNo,
      lastErrorCode: delivery.lastErrorCode,
    } as const;
  }

  #required(idempotencyKey: string): WebhookDelivery {
    const delivery = this.#deliveries.get(idempotencyKey);
    if (delivery === undefined) throw new Error("WEBHOOK_DELIVERY_NOT_FOUND");
    return delivery;
  }
}

function validateRetryPolicy(policy: WebhookRetryPolicy): void {
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts <= 0 || policy.baseDelayMs <= 0) {
    throw new Error("INVALID_WEBHOOK_RETRY_POLICY");
  }
}

function isHttpEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
