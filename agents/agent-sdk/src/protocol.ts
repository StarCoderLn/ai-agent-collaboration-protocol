import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 这些常量属于平台、SDK 与不同语言实现共同遵守的公共协议。字段名、大小写和签名基串
 * 顺序都不能由单个 Agent 自行调整；任何变化都需要升级协议版本并更新共享测试向量。
 */
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

export type SignedRequest = Readonly<{
  method: string;
  path: string;
  body: Uint8Array;
  timestamp: string;
  nonce: string;
  callType?: CallType;
}>;

export type SignedHeaders = Readonly<{
  "X-Protocol-Version": string;
  "X-Timestamp": string;
  "X-Nonce": string;
  "X-Signature": string;
  "X-Call-Type": CallType;
}>;

/** 生成 AICP v1 的字节级签名基串；JSON 请求体不得解析后重新序列化。 */
export function signatureBase(request: SignedRequest): Buffer {
  const callType = request.callType ?? "production";
  return Buffer.concat([
    Buffer.from(
      `${request.method}\n${request.path}\n${request.timestamp}\n${request.nonce}\n${callType}\n`,
      "utf8",
    ),
    Buffer.from(request.body),
  ]);
}

/** 计算十六进制 HMAC-SHA256；空密钥必须在产生可伪造签名前失败。 */
export function computeSignature(request: SignedRequest, secret: string): string {
  if (secret.length === 0) throw new Error("signing secret must not be empty");
  return createHmac("sha256", secret).update(signatureBase(request)).digest("hex");
}

/** 为平台回调或测试请求生成一组完整签名头。 */
export function signRequest(
  request: Pick<SignedRequest, "method" | "path" | "body"> & { callType?: CallType },
  secret: string,
  options: { now?: Date; nonce?: string } = {},
): SignedHeaders {
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1_000).toString();
  // 128 bit 随机数用于阻止签名有效期窗口内的重复请求。
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  const callType = request.callType ?? "production";
  return {
    "X-Protocol-Version": PROTOCOL_VERSION,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": computeSignature({ ...request, timestamp, nonce, callType }, secret),
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
    // 未知版本属于协商错误；其余认证失败统一使用 401，避免泄漏具体验证进度。
    return this.code === "PROTOCOL_VERSION_UNSUPPORTED" ? 400 : 401;
  }
}

/**
 * Nonce 仓库只暴露原子占用语义。生产适配器可使用数据库唯一约束或 Redis SET NX，
 * 协议验证器不需要知道存储位置与清理策略。
 */
export interface NonceStore {
  reserve(nonce: string): boolean;
}

/** 单进程开发仓库；服务重启或多副本部署时应替换为共享持久化实现。 */
export class MemoryNonceStore implements NonceStore {
  readonly #used = new Set<string>();

  reserve(nonce: string): boolean {
    if (this.#used.has(nonce)) return false;
    this.#used.add(nonce);
    return true;
  }
}

export type VerifyInput = Readonly<{
  method: string;
  path: string;
  headers: Readonly<Record<string, string | undefined>>;
  body: Uint8Array;
}>;

/**
 * 集中执行版本、时间窗、签名和防重放校验。只有签名正确的请求才占用 Nonce，避免匿名
 * 请求使用随机 Nonce 污染存储并阻止后续合法调用。
 */
export class ProtocolVerifier {
  readonly #secret: string;
  readonly #nonces: NonceStore;
  readonly #now: () => Date;
  readonly #windowSeconds: number;

  constructor(options: {
    secret: string;
    nonces?: NonceStore;
    now?: () => Date;
    windowSeconds?: number;
  }) {
    if (options.secret.length === 0) throw new Error("verification secret must not be empty");
    if ((options.windowSeconds ?? 300) <= 0) throw new Error("verification window must be positive");
    this.#secret = options.secret;
    this.#nonces = options.nonces ?? new MemoryNonceStore();
    this.#now = options.now ?? (() => new Date());
    this.#windowSeconds = options.windowSeconds ?? 300;
  }

  verify(input: VerifyInput): CallType {
    const version = input.headers[protocolHeaders.version];
    if (version !== PROTOCOL_VERSION) {
      throw new ProtocolError("PROTOCOL_VERSION_UNSUPPORTED", "unsupported protocol version");
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
    if (!this.#nonces.reserve(nonce)) {
      throw new ProtocolError("AUTH_REPLAYED_NONCE", "nonce already used");
    }
    return callType;
  }
}

function parseUnixSeconds(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ProtocolError("AUTH_EXPIRED_TIMESTAMP", "invalid or missing timestamp");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProtocolError("AUTH_EXPIRED_TIMESTAMP", "invalid or missing timestamp");
  }
  return parsed;
}

function normalizeCallType(value: string | undefined): CallType {
  // 缺省值必须是 production，避免遗漏标记的正式调用被误当成无影响的沙箱数据。
  if (value === undefined || value === "") return "production";
  if (value === "production" || value === "sandbox") return value;
  throw new ProtocolError("AUTH_INVALID_SIGNATURE", "invalid call type");
}

function constantTimeHexEqual(leftHex: string, rightHex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(leftHex)) return false;
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
