import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// 这些值属于跨语言公共协议。修改顺序、大小写或默认值都会破坏 Go/TypeScript 签名向量，
// 因此不能把它们当作普通内部常量随意调整。
export const PROTOCOL_VERSION = "1.0";
export const protocolHeaders = {
  version: "x-protocol-version",
  timestamp: "x-timestamp",
  nonce: "x-nonce",
  signature: "x-signature",
  callType: "x-call-type",
  idempotencyKey: "idempotency-key",
} as const;

export type CallType = "production" | "sandbox";

export type SignedRequest = {
  method: string;
  path: string;
  body: Uint8Array;
  timestamp: string;
  nonce: string;
  callType?: CallType;
};

export type SignedHeaders = {
  "X-Protocol-Version": string;
  "X-Timestamp": string;
  "X-Nonce": string;
  "X-Signature": string;
  "X-Call-Type": CallType;
};

export function signatureBase(request: SignedRequest): Buffer {
  const callType = request.callType ?? "production";
  // 签名基串顺序固定为：method、path、timestamp、nonce、callType、原始 body。
  // 每个文本字段以 LF 分隔；body 不解码、不规范化，确保二进制级防篡改。
  return Buffer.concat([
    Buffer.from(
      `${request.method}\n${request.path}\n${request.timestamp}\n${request.nonce}\n${callType}\n`,
      "utf8",
    ),
    Buffer.from(request.body),
  ]);
}

export function computeSignature(request: SignedRequest, secret: string): string {
  if (secret.length === 0) {
    throw new Error("signing secret must not be empty");
  }
  return createHmac("sha256", secret).update(signatureBase(request)).digest("hex");
}

export function signRequest(
  request: Pick<SignedRequest, "method" | "path" | "body"> & { callType?: CallType },
  secret: string,
  options: { now?: Date; nonce?: string } = {},
): SignedHeaders {
  // 秒级 Unix 时间用于服务端时间窗校验；128-bit 随机 nonce 用于阻止窗口内重放。
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1_000).toString();
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const callType = request.callType ?? "production";
  const signature = computeSignature({ ...request, timestamp, nonce, callType }, secret);
  return {
    "X-Protocol-Version": PROTOCOL_VERSION,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": signature,
    "X-Call-Type": callType,
  };
}

export type ProtocolErrorCode =
  | "AUTH_INVALID_SIGNATURE"
  | "AUTH_EXPIRED_TIMESTAMP"
  | "AUTH_REPLAYED_NONCE"
  | "PROTOCOL_VERSION_UNSUPPORTED";

export class ProtocolError extends Error {
  constructor(
    readonly code: ProtocolErrorCode,
    message: string,
  ) {
    super(message);
  }

  get status(): number {
    // 版本不支持是协议协商错误；其余认证失败统一返回 401，避免暴露过多验证细节。
    return this.code === "PROTOCOL_VERSION_UNSUPPORTED" ? 400 : 401;
  }
}

/**
 * v0.1 的进程内 nonce 仓库。它只保证单进程生命周期内防重放；重启或多实例部署前必须
 * 替换成带过期时间、原子 reserve 语义的共享持久化实现。
 */
export class MemoryNonceStore {
  readonly #used = new Set<string>();

  reserve(nonce: string): boolean {
    if (this.#used.has(nonce)) {
      return false;
    }
    this.#used.add(nonce);
    return true;
  }
}

export type VerifyInput = {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
};

export class ProtocolVerifier {
  readonly #secret: string;
  readonly #nonces: MemoryNonceStore;
  readonly #now: () => Date;
  readonly #windowSeconds: number;

  constructor(options: {
    secret: string;
    nonces?: MemoryNonceStore;
    now?: () => Date;
    windowSeconds?: number;
  }) {
    if (options.secret.length === 0) {
      throw new Error("verification secret must not be empty");
    }
    this.#secret = options.secret;
    this.#nonces = options.nonces ?? new MemoryNonceStore();
    this.#now = options.now ?? (() => new Date());
    this.#windowSeconds = options.windowSeconds ?? 300;
  }

  verify(input: VerifyInput): CallType {
    // 先拒绝未知版本，避免双方用不同基串规则验证同一个请求。
    const version = input.headers[protocolHeaders.version];
    if (version !== PROTOCOL_VERSION) {
      throw new ProtocolError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        `unsupported protocol version ${JSON.stringify(version ?? "")}`,
      );
    }

    const timestamp = input.headers[protocolHeaders.timestamp] ?? "";
    const timestampSeconds = parseUnixSeconds(timestamp);
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (Math.abs(nowSeconds - timestampSeconds) > this.#windowSeconds) {
      throw new ProtocolError("AUTH_EXPIRED_TIMESTAMP", "timestamp outside allowed window");
    }

    const nonce = input.headers[protocolHeaders.nonce] ?? "";
    const providedSignature = input.headers[protocolHeaders.signature] ?? "";
    if (nonce.length === 0 || providedSignature.length === 0) {
      throw new ProtocolError("AUTH_INVALID_SIGNATURE", "missing required signature fields");
    }

    const callType = normalizeCallType(input.headers[protocolHeaders.callType]);
    const expectedSignature = computeSignature(
      {
        method: input.method,
        path: input.path,
        timestamp,
        nonce,
        callType,
        body: input.body,
      },
      this.#secret,
    );
    if (!constantTimeHexEqual(providedSignature, expectedSignature)) {
      throw new ProtocolError("AUTH_INVALID_SIGNATURE", "signature mismatch");
    }

    // 只有签名有效后才占用 nonce，防止未认证攻击者提交随机 nonce 污染防重放仓库。
    if (!this.#nonces.reserve(nonce)) {
      throw new ProtocolError("AUTH_REPLAYED_NONCE", "nonce already used");
    }
    return callType;
  }
}

function parseUnixSeconds(value: string): number {
  if (!/^-?\d+$/.test(value)) {
    throw new ProtocolError("AUTH_EXPIRED_TIMESTAMP", "invalid or missing timestamp");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProtocolError("AUTH_EXPIRED_TIMESTAMP", "invalid or missing timestamp");
  }
  return parsed;
}

function normalizeCallType(value: string | undefined): CallType {
  // 为兼容未发送该头的 v1.0 调用方，缺省值是高风险的 production，而非 sandbox。
  if (value === undefined || value === "") {
    return "production";
  }
  if (value === "production" || value === "sandbox") {
    return value;
  }
  throw new ProtocolError("AUTH_INVALID_SIGNATURE", "invalid call type");
}

function constantTimeHexEqual(leftHex: string, rightHex: string): boolean {
  // 先验证固定长度十六进制格式，再使用 timingSafeEqual，避免普通字符串比较泄露时序。
  if (!/^[0-9a-fA-F]{64}$/.test(leftHex)) {
    return false;
  }
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
