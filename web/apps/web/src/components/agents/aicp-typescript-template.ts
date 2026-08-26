/**
 * 第三方 Agent 提供者可直接复制的最小 TypeScript 服务。
 *
 * 模板只依赖 Node.js 内置模块，避免用户还没理解协议就先被框架选型阻塞。它完整演示
 * AICP 的字节级验签、时间窗口、Nonce 防重放与幂等响应；内存 Map 则被明确标记为
 * 快速体验实现，生产环境必须替换为 Redis/数据库，避免多实例或重启后失去安全状态。
 */
export const AICP_TYPESCRIPT_TEMPLATE = String.raw`/**
 * AICP v1 Agent 接入模板
 *
 * 1. 保存为 server.ts
 * 2. 设置与上架表单一致的密钥：AICP_HMAC_SECRET=your-secret
 * 3. 启动：npx tsx server.ts
 * 4. 把公网地址填写为：https://your-domain.example/v1/agents/my-agent
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

const PORT = Number(process.env.PORT ?? 8787);
const HMAC_SECRET = process.env.AICP_HMAC_SECRET;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const MAX_BODY_BYTES = 4 * 1024 * 1024;

if (!HMAC_SECRET) {
  throw new Error('请先设置 AICP_HMAC_SECRET，且必须与上架表单中填写的共享签名密钥一致');
}

type CallType = 'production' | 'sandbox';
type StoredResponse = Readonly<{
  fingerprint: string;
  status: number;
  body: Readonly<Record<string, unknown>>;
}>;

/**
 * 快速体验使用内存集合；生产环境必须改成 Redis 或数据库并设置合理 TTL。
 * 只有通过签名校验的 Nonce 才能写入，防止未认证请求抢占合法 Nonce。
 */
const usedNonces = new Set<string>();
const idempotentResponses = new Map<string, StoredResponse>();

class ProtocolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProtocolError(401, 'AUTH_INVALID_SIGNATURE', '缺少必要的 AICP 请求头');
  }
  return value;
}

function optionalHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * 签名必须基于未经 JSON.parse 或重新序列化的原始请求体，否则空格和字段顺序变化会
 * 让合法签名失效。读取时同时限制大小，避免攻击者用超大请求占满 Agent 内存。
 */
async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY_BYTES) {
      throw new ProtocolError(413, 'REQUEST_TOO_LARGE', '请求体超过 4 MiB');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

/** 验证 AICP v1 契约；成功后返回已纳入签名的调用类型。 */
function verifyAicpRequest(
  request: IncomingMessage,
  pathname: string,
  rawBody: Buffer,
): CallType {
  const version = header(request, 'X-Protocol-Version');
  if (version !== '1.0') {
    throw new ProtocolError(400, 'PROTOCOL_VERSION_UNSUPPORTED', '仅支持 AICP 1.0');
  }

  const timestamp = header(request, 'X-Timestamp');
  if (!/^\d+$/.test(timestamp)) {
    throw new ProtocolError(401, 'AUTH_EXPIRED_TIMESTAMP', '时间戳格式不正确');
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isSafeInteger(Number(timestamp)) || skew > MAX_CLOCK_SKEW_SECONDS) {
    throw new ProtocolError(401, 'AUTH_EXPIRED_TIMESTAMP', '请求时间已超过允许窗口');
  }

  const nonce = header(request, 'X-Nonce');
  // 协议缺省值是 production，并且归一化后的 production 仍要进入签名基串。
  const callType = optionalHeader(request, 'X-Call-Type') ?? 'production';
  if (callType !== 'production' && callType !== 'sandbox') {
    throw new ProtocolError(400, 'CALL_TYPE_INVALID', 'X-Call-Type 必须是 production 或 sandbox');
  }

  const receivedSignature = header(request, 'X-Signature');
  if (!/^[0-9a-f]{64}$/i.test(receivedSignature)) {
    throw new ProtocolError(401, 'AUTH_INVALID_SIGNATURE', '签名格式不正确');
  }

  const method = request.method ?? '';
  const signingBase = Buffer.concat([
    Buffer.from([method, pathname, timestamp, nonce, callType, ''].join('\n')),
    rawBody,
  ]);
  const expectedSignature = createHmac('sha256', HMAC_SECRET)
    .update(signingBase)
    .digest();
  const receivedBytes = Buffer.from(receivedSignature, 'hex');

  // 常数时间比较避免签名逐字节比较泄露有效前缀长度。
  if (!timingSafeEqual(expectedSignature, receivedBytes)) {
    throw new ProtocolError(401, 'AUTH_INVALID_SIGNATURE', '签名不匹配');
  }
  if (usedNonces.has(nonce)) {
    throw new ProtocolError(401, 'AUTH_REPLAYED_NONCE', 'Nonce 已使用');
  }
  usedNonces.add(nonce);
  return callType;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Readonly<Record<string, unknown>>,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://agent.local');
    const rawBody = await readRawBody(request);

    // 平台健康探测同样携带 AICP 签名，避免把内部状态端点完全暴露给匿名调用者。
    if (request.method === 'GET' && url.pathname === '/healthz') {
      verifyAicpRequest(request, url.pathname, rawBody);
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    const route = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname);
    if (request.method !== 'POST' || route === null) {
      sendJson(response, 404, { error_code: 'NOT_FOUND', retryable: false });
      return;
    }

    const encodedAgentId = route[1];
    if (encodedAgentId === undefined) {
      throw new ProtocolError(400, 'AGENT_ID_INVALID', 'Agent ID 不能为空');
    }

    const callType = verifyAicpRequest(request, url.pathname, rawBody);
    const idempotencyKey = header(request, 'Idempotency-Key');
    const fingerprint = createHash('sha256').update(rawBody).digest('hex');
    const previous = idempotentResponses.get(idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new ProtocolError(409, 'IDEMPOTENCY_CONFLICT', '相同幂等键不能用于不同任务内容');
      }
      sendJson(response, previous.status, previous.body, { 'x-idempotent-replay': 'true' });
      return;
    }

    let task: unknown;
    try {
      task = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new ProtocolError(400, 'INVALID_JSON', '请求体必须是合法 JSON');
    }

    // 在这里调用你的 Mastra、LangGraph 或自研 Agent。先持久化任务再返回 202，避免
    // 服务进程中断后平台误以为任务已经安全进入执行队列。
    console.log('收到已验签任务', {
      agentId: decodeURIComponent(encodedAgentId),
      callType,
      // 不要在生产日志打印完整任务、签名、密钥或用户敏感内容。
      payloadType: typeof task,
    });
    const accepted = { queued: true, agentId: decodeURIComponent(encodedAgentId), callType };

    // 生产环境应在同一数据库事务内保存任务和响应快照，再返回成功。
    idempotentResponses.set(idempotencyKey, {
      fingerprint,
      status: 202,
      body: accepted,
    });
    sendJson(response, 202, accepted);
  } catch (error) {
    if (error instanceof ProtocolError) {
      sendJson(response, error.status, {
        error_code: error.code,
        message: error.message,
        retryable: false,
      });
      return;
    }
    console.error('Agent 内部错误', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    sendJson(response, 500, {
      error_code: 'AGENT_INTERNAL_ERROR',
      message: 'Agent 内部错误',
      retryable: true,
    });
  }
});

server.listen(PORT, () => {
  console.log('AICP Agent 正在监听 http://localhost:' + PORT);
});
`;
