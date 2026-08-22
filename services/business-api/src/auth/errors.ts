/**
 * 提供者钱包认证（SIWE）的统一错误响应结构（2.agent-registration T-010）。
 *
 * design.md 模块 5 / 接口契约明确要求：`POST /api/auth/verify` 失败（签名不符/
 * nonce 过期或已用/地址格式非法/domain-uri-chainId 不匹配）一律返回同一个 401，
 * 不泄露具体是哪一步校验失败——因此本模块只暴露一个统一的
 * `SIWE_VERIFICATION_FAILED` 错误码，不像 `agents/errors.ts` 那样按失败原因区分
 * 多个错误码。
 */

export type AuthApiErrorCode = "SIWE_VERIFICATION_FAILED" | "AUTH_INTERNAL_ERROR";

const HTTP_STATUS: Readonly<Record<AuthApiErrorCode, number>> = {
  SIWE_VERIFICATION_FAILED: 401,
  AUTH_INTERNAL_ERROR: 500,
};

const RETRYABLE: Readonly<Record<AuthApiErrorCode, boolean>> = {
  SIWE_VERIFICATION_FAILED: false,
  AUTH_INTERNAL_ERROR: true,
};

const MESSAGE: Readonly<Record<AuthApiErrorCode, string>> = {
  SIWE_VERIFICATION_FAILED: "签名校验失败",
  AUTH_INTERNAL_ERROR: "认证服务暂不可用，请稍后重试",
};

export interface AuthApiErrorResponse {
  error_code: AuthApiErrorCode;
  message: string;
  retryable: boolean;
}

export class AuthApiError extends Error {
  readonly code: AuthApiErrorCode;
  readonly httpStatus: number;

  constructor(code: AuthApiErrorCode) {
    super(MESSAGE[code]);
    this.name = "AuthApiError";
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }

  toResponse(): AuthApiErrorResponse {
    return { error_code: this.code, message: this.message, retryable: RETRYABLE[this.code] };
  }
}
