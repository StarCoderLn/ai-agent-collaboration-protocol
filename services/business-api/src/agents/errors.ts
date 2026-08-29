/**
 * Agent 档案 API 的统一错误响应结构（2.agent-registration T-004）。
 *
 * 字段命名（`error_code`/`message`/`retryable`）复用
 * `services/dispatch-engine/internal/protocol` 已定义的协议层错误响应形状
 * （design.md「接口契约」：「错误响应复用 1.agent-protocol-contract 定义的统一错误码结构」），
 * 但取值集合是本模块（业务 CRUD 错误）的权威定义，不与协议层的 Agent 通信错误码
 * （如 AUTH_INVALID_SIGNATURE、CONN_TIMEOUT 等）混用——两者描述的是不同层面的失败语义。
 */

export type AgentApiErrorCode =
  | "VALIDATION_FAILED"
  | "WALLET_ADDRESS_IMMUTABLE"
  | "AGENT_NOT_FOUND"
  | "AGENT_ACCESS_DENIED";

/** 业务 CRUD 校验/查找失败均不可通过原样重试同一请求恢复。 */
const RETRYABLE: Readonly<Record<AgentApiErrorCode, boolean>> = {
  VALIDATION_FAILED: false,
  WALLET_ADDRESS_IMMUTABLE: false,
  AGENT_NOT_FOUND: false,
  AGENT_ACCESS_DENIED: false,
};

const HTTP_STATUS: Readonly<Record<AgentApiErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  WALLET_ADDRESS_IMMUTABLE: 400,
  AGENT_NOT_FOUND: 404,
  AGENT_ACCESS_DENIED: 403,
};

export interface AgentApiErrorResponse {
  error_code: AgentApiErrorCode;
  message: string;
  retryable: boolean;
  /**
   * 字段级错误详情（requirements.md F-003/AC-001：「明确标出具体原因字段」）。
   * key 为请求体字段名，value 为该字段的具体错误说明。
   */
  fields?: Record<string, string>;
}

/**
 * Agent 档案 API 的业务错误。各正式 HTTP Handler 捕获后经
 * `toResponse()` 转换为对外 JSON 响应，不得在多处各自拼装错误结构
 * （AGENTS.md 第 9 条：单一权威位置）。
 */
export class AgentApiError extends Error {
  readonly code: AgentApiErrorCode;
  readonly httpStatus: number;
  readonly fields: Record<string, string> | undefined;

  constructor(code: AgentApiErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = "AgentApiError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.fields = fields;
  }

  toResponse(): AgentApiErrorResponse {
    const response: AgentApiErrorResponse = {
      error_code: this.code,
      message: this.message,
      retryable: RETRYABLE[this.code],
    };
    return this.fields ? { ...response, fields: this.fields } : response;
  }
}
