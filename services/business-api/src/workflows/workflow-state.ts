/**
 * 正式多 Agent 工作流的纯领域状态机。
 *
 * 本模块不读取数据库、时间或网络。数据库仓储只能把已锁定快照交给这里计算，再原子写回；
 * 这样节点解锁、失败与工作流聚合状态不会在 HTTP、worker 和前端复制成多套判断。
 */

export type WorkflowRunStatus =
  | "planning"
  | "running"
  | "awaiting_review"
  | "completed"
  | "failed"
  | "disputed"
  | "cancelled";

export type WorkflowNodeStatus =
  | "selecting"
  | "selected"
  | "blocked"
  | "matching"
  | "awaiting_agent_acceptance"
  | "executing"
  | "execution_failed"
  | "awaiting_review"
  | "rework"
  | "accepted"
  | "disputed"
  | "cancelled";

export type WorkflowNodeEvent =
  | Readonly<{ type: "candidate_selected" }>
  | Readonly<{ type: "root_execution_activated" }>
  | Readonly<{ type: "dependent_execution_activated" }>
  | Readonly<{ type: "assignment_locked" }>
  | Readonly<{ type: "agent_accepted" }>
  | Readonly<{ type: "assignment_failed" }>
	| Readonly<{ type: "stale_execution_recovery" }>
  | Readonly<{ type: "progress_reported" }>
  | Readonly<{ type: "execution_failed" }>
  | Readonly<{ type: "results_submitted" }>
  | Readonly<{ type: "rework_requested" }>
  | Readonly<{ type: "result_accepted" }>
  | Readonly<{ type: "dispute_opened" }>
  | Readonly<{ type: "cancelled" }>;

export type WorkflowNodeSnapshot = Readonly<{
  id: string;
  status: WorkflowNodeStatus;
}>;

export type WorkflowEdgeSnapshot = Readonly<{
  sourceNodeId: string;
  targetNodeId: string;
}>;

export class WorkflowStateError extends Error {
  constructor(readonly code: "INVALID_NODE_TRANSITION" | "INVALID_WORKFLOW_GRAPH", message: string) {
    super(message);
  }
}

const NODE_TRANSITIONS: Readonly<Record<WorkflowNodeStatus, Partial<Record<WorkflowNodeEvent["type"], WorkflowNodeStatus>>>> = {
  selecting: { candidate_selected: "selected", cancelled: "cancelled" },
  // selected 只表示报价已冻结，不代表 Agent 已收到任务。托管确认后，根节点进入
  // matching，存在上游依赖的节点进入 blocked，执行顺序仍由 DAG 解锁规则控制。
  selected: {
    root_execution_activated: "matching",
    dependent_execution_activated: "blocked",
    cancelled: "cancelled",
  },
  blocked: { cancelled: "cancelled" },
  matching: { assignment_locked: "awaiting_agent_acceptance", cancelled: "cancelled" },
  awaiting_agent_acceptance: {
    agent_accepted: "executing",
    assignment_failed: "matching",
    cancelled: "cancelled",
  },
  executing: {
    progress_reported: "executing",
    execution_failed: "execution_failed",
		// 只有持久化仓储证明执行快照仍绑定旧 assignment 时，才会构造这个内部事件。
		// 外部 assignment_failed 不能直接从 executing 回退，避免打断正常模型调用。
		stale_execution_recovery: "matching",
    results_submitted: "awaiting_review",
    dispute_opened: "disputed",
    cancelled: "cancelled",
  },
  execution_failed: {
    assignment_failed: "matching",
    dispute_opened: "disputed",
    cancelled: "cancelled",
  },
  awaiting_review: {
    rework_requested: "rework",
    result_accepted: "accepted",
    dispute_opened: "disputed",
    cancelled: "cancelled",
  },
  rework: {
    progress_reported: "rework",
    execution_failed: "execution_failed",
    results_submitted: "awaiting_review",
    dispute_opened: "disputed",
    cancelled: "cancelled",
  },
  accepted: {},
  disputed: { cancelled: "cancelled" },
  cancelled: {},
};

/** 非法组合不可静默忽略，否则重复或乱序回调会伪造节点已推进。 */
export function transitionWorkflowNode(
  current: WorkflowNodeStatus,
  event: WorkflowNodeEvent,
): WorkflowNodeStatus {
  const next = NODE_TRANSITIONS[current][event.type];
  if (next === undefined) {
    throw new WorkflowStateError(
      "INVALID_NODE_TRANSITION",
      `workflow node cannot apply ${event.type} from ${current}`,
    );
  }
  return next;
}

/**
 * 只解锁所有上游都已验收的 blocked 节点。没有上游的根节点立即进入 matching；
 * 并行分支会在共同前置节点验收后同时解锁，不依赖数组顺序。
 */
export function unlockReadyWorkflowNodes(
  nodes: readonly WorkflowNodeSnapshot[],
  edges: readonly WorkflowEdgeSnapshot[],
): readonly WorkflowNodeSnapshot[] {
  assertValidWorkflowGraph(nodes, edges);
  const statusById = new Map(nodes.map((node) => [node.id, node.status]));
  const predecessors = predecessorMap(nodes, edges);
  return nodes.map((node) => {
    if (node.status !== "blocked") return node;
    const upstream = predecessors.get(node.id) ?? [];
    const ready = upstream.every((nodeId) => statusById.get(nodeId) === "accepted");
    return ready ? { ...node, status: "matching" as const } : node;
  });
}

/** 工作流状态是节点事实的投影，不允许调用方自行传入相互矛盾的聚合状态。 */
export function aggregateWorkflowStatus(nodes: readonly WorkflowNodeSnapshot[]): WorkflowRunStatus {
  if (nodes.length === 0) {
    throw new WorkflowStateError("INVALID_WORKFLOW_GRAPH", "workflow must contain at least one node");
  }
  if (nodes.every((node) => node.status === "accepted")) return "completed";
  if (nodes.some((node) => node.status === "disputed")) return "disputed";
  if (nodes.every((node) => node.status === "cancelled")) return "cancelled";
  if (nodes.some((node) => node.status === "execution_failed")) return "failed";
  if (nodes.some((node) => node.status === "awaiting_review")) return "awaiting_review";
  if (nodes.every((node) => node.status === "selecting" || node.status === "selected")) return "planning";
  if (nodes.every((node) => node.status === "blocked")) return "planning";
  return "running";
}

/**
 * DAG 校验集中在领域边界：拒绝缺失节点、自环和环路。数据库外键只能保证端点存在，
 * 无法表达整张图无环；不在这里验证会让“等待所有上游”永久卡死。
 */
export function assertValidWorkflowGraph(
  nodes: readonly WorkflowNodeSnapshot[],
  edges: readonly WorkflowEdgeSnapshot[],
): void {
  if (nodes.length === 0) {
    throw new WorkflowStateError("INVALID_WORKFLOW_GRAPH", "workflow must contain at least one node");
  }
  const ids = new Set<string>();
  for (const node of nodes) {
    if (node.id.trim() === "" || ids.has(node.id)) {
      throw new WorkflowStateError("INVALID_WORKFLOW_GRAPH", "workflow node ids must be non-empty and unique");
    }
    ids.add(node.id);
  }
  const outgoing = new Map<string, string[]>();
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (!ids.has(edge.sourceNodeId) || !ids.has(edge.targetNodeId) || edge.sourceNodeId === edge.targetNodeId) {
      throw new WorkflowStateError("INVALID_WORKFLOW_GRAPH", "workflow edge endpoints are invalid");
    }
    outgoing.set(edge.sourceNodeId, [...(outgoing.get(edge.sourceNodeId) ?? []), edge.targetNodeId]);
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1);
  }
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    visited += 1;
    for (const target of outgoing.get(current) ?? []) {
      const next = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, next);
      if (next === 0) ready.push(target);
    }
  }
  if (visited !== nodes.length) {
    throw new WorkflowStateError("INVALID_WORKFLOW_GRAPH", "workflow dependencies must form an acyclic graph");
  }
}

function predecessorMap(
  nodes: readonly WorkflowNodeSnapshot[],
  edges: readonly WorkflowEdgeSnapshot[],
): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    result.get(edge.targetNodeId)?.push(edge.sourceNodeId);
  }
  return result;
}
