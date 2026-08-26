import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

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
type SignedRequest = {
  method: string;
  path: string;
  body: Uint8Array;
  timestamp: string;
  nonce: string;
  callType: CallType;
};

function signatureBase(request: SignedRequest): Buffer {
  // 该顺序是公共协议 v1.0 的字节级契约，不能按 JSON 语义重新排序或规范化 body。
  return Buffer.concat([
    Buffer.from(
      `${request.method}\n${request.path}\n${request.timestamp}\n${request.nonce}\n${request.callType}\n`,
      "utf8",
    ),
    Buffer.from(request.body),
  ]);
}

function computeSignature(request: SignedRequest, secret: string): string {
  return createHmac("sha256", secret).update(signatureBase(request)).digest("hex");
}

export function signRequest(
  request: Pick<SignedRequest, "method" | "path" | "body" | "callType">,
  secret: string,
  options: { now?: Date; nonce?: string } = {},
): Record<string, string> {
  const timestamp = Math.floor((options.now ?? new Date()).getTime() / 1_000).toString();
  const nonce = options.nonce ?? randomBytes(16).toString("base64url");
  return {
    "X-Protocol-Version": PROTOCOL_VERSION,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": computeSignature({ ...request, timestamp, nonce }, secret),
    "X-Call-Type": request.callType,
  };
}

type ProtocolErrorCode =
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
    return this.code === "PROTOCOL_VERSION_UNSUPPORTED" ? 400 : 401;
  }
}

class MemoryNonceStore {
  readonly #used = new Set<string>();

  reserve(nonce: string): boolean {
    if (this.#used.has(nonce)) {
      return false;
    }
    this.#used.add(nonce);
    return true;
  }
}

export class ProtocolVerifier {
  readonly #secret: string;
  readonly #nonces = new MemoryNonceStore();
  readonly #now: () => Date;

  constructor(options: { secret: string; now?: () => Date }) {
    if (options.secret.length < 16) {
      throw new Error("verification secret must contain at least 16 characters");
    }
    this.#secret = options.secret;
    this.#now = options.now ?? (() => new Date());
  }

  verify(input: {
    method: string;
    path: string;
    headers: Readonly<Record<string, string | undefined>>;
    body: Uint8Array;
  }): CallType {
    const version = input.headers[protocolHeaders.version];
    if (version !== PROTOCOL_VERSION) {
      throw new ProtocolError("PROTOCOL_VERSION_UNSUPPORTED", "unsupported protocol version");
    }
    const timestamp = input.headers[protocolHeaders.timestamp] ?? "";
    const timestampSeconds = parseTimestamp(timestamp);
    const nowSeconds = Math.floor(this.#now().getTime() / 1_000);
    if (Math.abs(nowSeconds - timestampSeconds) > 300) {
      throw new ProtocolError("AUTH_EXPIRED_TIMESTAMP", "timestamp outside allowed window");
    }
    const nonce = input.headers[protocolHeaders.nonce] ?? "";
    const signature = input.headers[protocolHeaders.signature] ?? "";
    const callType = normalizeCallType(input.headers[protocolHeaders.callType]);
    if (nonce.length === 0 || signature.length === 0) {
      throw new ProtocolError("AUTH_INVALID_SIGNATURE", "missing signature fields");
    }
    const expected = computeSignature(
      { method: input.method, path: input.path, body: input.body, timestamp, nonce, callType },
      this.#secret,
    );
    if (!constantTimeHexEqual(signature, expected)) {
      throw new ProtocolError("AUTH_INVALID_SIGNATURE", "signature mismatch");
    }
    if (!this.#nonces.reserve(nonce)) {
      throw new ProtocolError("AUTH_REPLAYED_NONCE", "nonce already used");
    }
    return callType;
  }
}

function parseTimestamp(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new ProtocolError("AUTH_EXPIRED_TIMESTAMP", "invalid timestamp");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProtocolError("AUTH_EXPIRED_TIMESTAMP", "invalid timestamp");
  }
  return parsed;
}

function normalizeCallType(value: string | undefined): CallType {
  if (value === undefined || value === "") {
    return "production";
  }
  if (value === "production" || value === "sandbox") {
    return value;
  }
  throw new ProtocolError("AUTH_INVALID_SIGNATURE", "invalid call type");
}

function constantTimeHexEqual(leftHex: string, rightHex: string): boolean {
  if (!/^[0-9a-fA-F]{64}$/.test(leftHex)) {
    return false;
  }
  const left = Buffer.from(leftHex, "hex");
  const right = Buffer.from(rightHex, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}
