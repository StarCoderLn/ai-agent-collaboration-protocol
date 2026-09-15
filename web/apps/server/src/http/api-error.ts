/**
 * 交易/业务服务对外错误响应契约（2.agent-registration T-003）。
 *
 * 复用 [[1.agent-protocol-contract]] design.md「模块 3：错误码与重试/超时语义」定义的
 * 统一 JSON 结构 `{ error_code, message, retryable }`（Go 与 TypeScript 各自维护同构定义，
 * 通过共享 schema 文档保持一致，而非物理共享包，见 1.agent-protocol-contract/design.md
 * 技术决策）。`fields` 是本 feature 在基础契约上的加法扩展（design.md 模块 3：失败返回
 * 字段级错误），不破坏基础结构，兼容只读 `error_code`/`message`/`retryable` 的客户端。
 */

import type { FieldError } from "../agents/create-agent-input";

export type ApiErrorCode =
	| "VALIDATION_FAILED"
	| "IDEMPOTENCY_KEY_MISSING"
	| "IDEMPOTENCY_REQUEST_IN_PROGRESS"
	| "WALLET_OWNERSHIP_MISMATCH"
	| "AGENT_INTERNAL_ERROR";

export interface ApiErrorBody {
	error_code: ApiErrorCode;
	message: string;
	retryable: boolean;
	fields?: FieldError[];
}

export class ApiError extends Error {
	readonly httpStatus: number;
	readonly body: ApiErrorBody;

	constructor(httpStatus: number, body: ApiErrorBody) {
		super(body.message);
		this.httpStatus = httpStatus;
		this.body = body;
	}
}

export function validationFailedError(fields: FieldError[]): ApiError {
	return new ApiError(422, {
		error_code: "VALIDATION_FAILED",
		message: "请求字段校验失败",
		retryable: false,
		fields,
	});
}

export function idempotencyKeyMissingError(): ApiError {
	return new ApiError(400, {
		error_code: "IDEMPOTENCY_KEY_MISSING",
		message: "请求缺少 Idempotency-Key 请求头",
		retryable: false,
	});
}

export function idempotencyInProgressError(): ApiError {
	return new ApiError(409, {
		error_code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
		message:
			"同一 Idempotency-Key 的请求正在处理中，请稍后重试，不要更换 Idempotency-Key",
		retryable: true,
	});
}

/**
 * `walletAddress` 与认证边界确认的操作者身份不一致（security.md 认证与授权第 1 条：
 * 不得仅凭请求体中的 ID 字段判定身份）。禁止代表他人钱包地址创建 Agent 档案。
 */
export function walletOwnershipMismatchError(): ApiError {
	return new ApiError(403, {
		error_code: "WALLET_OWNERSHIP_MISMATCH",
		message: "walletAddress 必须与已认证的操作者钱包地址一致",
		retryable: false,
	});
}
