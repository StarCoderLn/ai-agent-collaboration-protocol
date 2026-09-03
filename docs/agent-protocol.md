# Agent 接入协议规格

本文档面向**第三方 Agent 团队**：描述平台如何调用独立部署的 Agent 服务。协议不绑定
Mastra、LangChain、LangGraph 等具体框架，也不绑定具体模型或资金链。

平台提供两种明确分离的接入模式：普通提供者默认使用**快速 HTTP JSON**；需要异步回调、
请求签名和自管幂等的团队可使用**高级 AICP HMAC**。历史 Agent 继续保持原 HMAC 行为，
平台不会因新增快速模式而静默改变其认证语义。

## 文档版本

| 日期       | 版本 | 说明                                        |
| ---------- | ---- | ------------------------------------------- |
| 2026-08-21 | v1   | 初始版本，覆盖协议 v1.0（含沙箱标记 F-006） |
| 2026-09-03 | v2   | 新增 `@aicp/agent-sdk` 默认接入方式；原始协议保留为审计与跨语言实现参考 |
| 2026-09-03 | v3   | 快速 HTTP JSON 成为默认接入；SDK/HMAC 调整为高级兼容方式 |

## 1. 默认方式：快速 HTTP JSON

上架页保留两个直接面向提供者的字段：

- `Agent 执行地址`：填写现有 Agent 的 `POST /run` 完整地址。
- `访问密钥`：可选；只有现有服务需要 Bearer Token 时填写。

同一 origin 必须提供健康端点：

```http
GET /healthz
```

```json
{ "status": "ok" }
```

平台的“测试连接”只调用该端点，不发送测试任务，不触发模型调用。正式环境只允许公网
HTTPS；本地体验模式才允许 loopback HTTP。为避免服务端请求伪造和 DNS rebinding，平台
会校验目标地址、解析结果并固定本次请求使用的已验证 IP。

正式执行端点接收以下 JSON：

```json
{
  "task": { "title": "任务标题", "description": "任务说明" },
  "upstreamArtifacts": []
}
```

`task` 包含本阶段任务信息；`upstreamArtifacts` 包含已完成上游阶段的完整产物。下游 Agent
必须消费上游产物，不能只读摘要后重新猜测需求。

成功响应必须在一次同步 HTTP 响应中返回：

```json
{
  "status": "completed",
  "artifacts": [
    {
      "type": "document",
      "summary": "任务交付",
      "content": "完整交付内容"
    }
  ]
}
```

约束如下：

- `status` 固定为 `completed`。
- `artifacts` 包含 1～3 个产物。
- `type` 支持 `document`、`code`、`json`、`website`、`image`、`video`。
- `summary` 和 `content` 必须是有效的非空内容。
- 响应正文只能包含一段 JSON，不接受尾随第二段 JSON。
- 填写`访问密钥`时，健康检查和正式执行均携带 `Authorization: Bearer <访问密钥>`；
  未填写时不发送伪造认证头。

平台在调用 Agent 前生成并持久化正式派发正文。同步结果先保存，再确认接单并转交业务服务；
如果内部转交暂时失败，平台只重试转交已保存结果，不会再次调用 Agent 或重复产生模型费用。
快速 Agent 不接收生命周期 Webhook，任务状态、重试和结果保存由平台代管。

以下示例可直接套到已有 Node.js 服务中，不要求安装平台 SDK：

```ts
app.get("/healthz", (_request, response) =>
  response.json({ status: "ok" }),
);

app.post("/run", async (request, response) => {
  const result = await myAgent.run({
    task: request.body.task,
    context: request.body.upstreamArtifacts,
  });

  response.json({
    status: "completed",
    artifacts: [{ type: "document", summary: "任务交付", content: result }],
  });
});
```

## 2. 高级方式：AICP HMAC 与 SDK

需要异步接单、进度回调、防重放和自管幂等时，可使用仓库内 `@aicp/agent-sdk`，或根据
后续章节自行实现 AICP v1。SDK 当前供平台自建 Agent 使用，尚未发布到 npm；它不是默认
上架页的依赖。SDK 的单进程默认去重存储只适合本地验证，多实例生产部署需要共享持久化
适配器。

以下 AICP v1 章节只适用于 `aicp_hmac` 模式。

### 2.1 协议版本

每个请求必须携带：

```
X-Protocol-Version: 1.0
```

平台收到不识别的版本号时，会在触碰任何签名/时间窗口逻辑之前直接拒绝，返回 `PROTOCOL_VERSION_UNSUPPORTED`（见 2.4 节），不会静默按当前版本或旧版本猜测处理。协议出现不兼容变更（请求头语义变化、签名基串构成变化）时版本号会递增，Agent 团队应在收到该错误码后升级客户端，而不是重试原始请求。

### 2.2 请求签名与认证

#### 2.2.1 请求头

| 请求头                | 说明                                                          |
| ---------------------- | ------------------------------------------------------------- |
| `X-Protocol-Version`   | 协议版本号，当前固定 `1.0`                                    |
| `X-Timestamp`          | 十进制 Unix 秒时间戳字符串                                    |
| `X-Nonce`               | 一次性随机字符串，需具备足够熵（平台生成侧使用 128 bit 随机数） |
| `X-Signature`          | HMAC-SHA256 签名，十六进制编码                                 |
| `X-Call-Type`           | `sandbox` 或 `production`；缺省时按 `production` 处理，详见 2.3 节 |

#### 2.2.2 签名算法

签名算法固定为 **HMAC-SHA256**，密钥（`secret`）来自双方在 Agent 注册流程中协商并加密存储的凭证。签名基串由以下字段依次拼接、以 `\n` 分隔（`body` 置于末尾，不加分隔符）：

```
method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n" + call_type + "\n" + body
```

- `method`：HTTP 方法，原样大小写（如 `POST`），发起方与验签方必须使用完全一致的大小写。
- `path`：请求路径，不含协议、host、query string。
- `timestamp`：`X-Timestamp` 的值。
- `nonce`：`X-Nonce` 的值。
- `call_type`：`X-Call-Type` 的值；未显式声明时按空字符串参与归一化（归一化结果见 2.3 节），发起方与验签方对"未声明等同 production"的理解必须一致。
- `body`：请求体原始字节；无请求体时为空字节序列。

`signature = hex(HMAC_SHA256(secret, base_string))`，写入 `X-Signature`。

验签方按同一规则重新计算基串并比对签名（常数时间比较，避免时序攻击），任意分量被篡改都会导致验签失败，返回 `AUTH_INVALID_SIGNATURE`——包括 `X-Call-Type` 被篡改的情况：`call_type` 纳入签名基串，防止中间人把 `sandbox` 篡改为 `production`（反之亦然）来污染正式历史或绕过沙箱标记。

#### 2.2.3 时间窗口

`X-Timestamp` 与验签方当前时间的偏差超出允许窗口（默认 **±5 分钟**，平台侧可配置）时，请求在计算签名之前即被拒绝，返回 `AUTH_EXPIRED_TIMESTAMP`。Agent 服务应确保系统时钟与 NTP 同步，避免因时钟漂移导致合法请求被拒。

#### 2.2.4 防重放（Nonce）

`X-Nonce` 全局唯一，一旦被平台成功验签占用即永久失效——同一 `(timestamp, nonce)` 组合的历史请求重放会被拒绝，返回 `AUTH_REPLAYED_NONCE`。每次请求都必须生成新的、不可预测的 nonce（建议使用密码学安全随机数生成器，至少 128 bit 熵），不得复用或使用可预测序列。

#### 2.2.5 凭证轮换

平台支持签名密钥轮换：轮换期间新旧密钥并行有效，验签方会依次尝试所有当前有效密钥，命中任意一个即视为验签通过。Agent 团队收到平台的密钥轮换通知后，应在旧密钥失效前完成切换，无需协调"零窗口"切换时刻。

#### 2.2.6 校验顺序

平台对入站请求的校验顺序固定为：**协议版本 → 时间窗口 → 必填字段 → 签名 → nonce 占用**。签名必须先于 nonce 占用校验通过，未认证的请求没有能力抢占合法 nonce。Agent 团队据此可以预期：一个签名错误的请求即使 nonce 是全新的，也不会因为"签名校验在 nonce 之后"而消耗掉这个 nonce。

### 2.3 沙箱模式标记（`X-Call-Type`）

沙箱标记用于区分「[[15.agent-sandbox-admission]] 沙箱调用」与「正式任务调用」，使平台的审计记录、Agent 历史统计、评分计算能够据此排除测试调用，不让沙箱调用污染 Agent 的正式历史数据。

| 取值         | 含义                                                             |
| ------------ | ------------------------------------------------------------------ |
| `production` | 正式任务调用（**默认值**，未显式声明 `X-Call-Type` 时按此处理） |
| `sandbox`    | 沙箱准入流程发起的测试调用，需调用方显式声明                     |

**默认值选择为 `production` 而非 `sandbox`**：遗漏标记的调用被当作正式任务处理，比遗漏标记的沙箱调用被误算进正式历史（污染评分/历史数据且难以事后区分）更安全、更容易恢复。Agent 团队实现测试/沙箱调用路径时，必须显式设置 `X-Call-Type: sandbox`，不能依赖"忘记设置就是沙箱"的假设。

`call_type` 纳入签名基串（见 2.2.2 节），第三方无法在不重新签名的情况下篡改该标记。

### 2.4 错误码与重试语义

所有受保护端点的失败响应统一为以下 JSON 结构：

```json
{
  "error_code": "AUTH_INVALID_SIGNATURE",
  "message": "signature mismatch",
  "retryable": false
}
```

`message` 不包含密钥、签名原文等敏感信息。`retryable` 由 `error_code` 唯一决定，Agent 团队应依据该字段而非自行猜测决定是否重试。

| `error_code`                     | HTTP 状态 | 类别         | `retryable` | 语义与建议动作                                                                 |
| --------------------------------- | --------- | ------------ | ------------ | -------------------------------------------------------------------------------- |
| `AUTH_INVALID_SIGNATURE`          | 401       | 认证失败     | `false`      | 签名不匹配或必填签名字段缺失。需检查密钥、基串拼接顺序后重新生成签名，原样重试无效。 |
| `AUTH_EXPIRED_TIMESTAMP`          | 401       | 认证失败     | `false`      | 时间戳超出允许窗口。需校正时钟或以当前时间戳重新生成请求。                       |
| `AUTH_REPLAYED_NONCE`             | 401       | 认证失败     | `false`      | `(timestamp, nonce)` 组合已被使用过。需以新 nonce 重新发起请求。                 |
| `PROTOCOL_VERSION_UNSUPPORTED`    | 400       | 协议不兼容   | `false`      | `X-Protocol-Version` 平台不识别。需升级/降级客户端到平台支持的版本后再重试。     |
| `CONN_TIMEOUT`                    | 504       | 连接超时     | `true`       | 平台/Agent 之间连接超时。可安全重试，建议指数退避（1s/2s/4s/.../最多 5 次）。      |
| `AGENT_INTERNAL_ERROR`            | 502       | Agent 内部错误 | `true`       | Agent 侧返回内部错误。是否重试或更换候选 Agent 由平台派发侧决定，标记 `retryable=true` 供参考，Agent 侧无需自行重试。 |

四个类别互不重叠：认证失败与协议不兼容不可重试（需修正请求本身），连接超时与 Agent 内部错误可重试。

### 2.5 幂等键

派发请求、结果提交、Webhook 回调必须携带幂等键，格式：

```
{operation}:{taskId}:{clientGeneratedId}
```

- `operation`：操作类型（如 `dispatch`、`result-submit`）。
- `taskId`：任务 ID。
- `clientGeneratedId`：调用方生成的唯一 ID（如 UUID），用于区分同一 `operation:taskId` 下的不同逻辑请求。

幂等键由调用方生成、平台侧持久化去重。行为契约：

1. **首次请求**（幂等键未被占用）：平台执行一次业务逻辑，成功后落盘响应快照。
2. **重复请求**（幂等键已提交历史响应）：平台**直接返回历史响应快照**，不重新执行业务逻辑——Agent 团队据此实现的重试逻辑（如网络超时后重发相同请求）不会导致重复派发或重复结果提交。
3. **并发到达、尚未提交**（幂等键已被占用但业务逻辑尚未执行完毕）：平台返回"请求正在处理中"，不会当作全新请求重新执行，也不会返回空响应冒充历史结果。Agent 团队应据此区分"已有确定结果"与"仍在处理中，需要稍后查询或重试"两种情况，不能把两者混为一谈。

幂等记录默认保留 **7 天**（TTL），过期由平台侧定时任务清理；过期后使用相同幂等键会被当作全新请求处理。

### 2.6 最小可用集成示例（伪代码）

以下伪代码演示第三方 Agent 团队实现一次「Agent 回调平台上报健康状态」的最小签名调用，用于对照本规格自测：

```python
import hmac, hashlib, time, secrets, base64

def sign_request(method: str, path: str, body: bytes, secret: str, call_type: str = "production") -> dict:
    timestamp = str(int(time.time()))
    nonce = base64.urlsafe_b64encode(secrets.token_bytes(16)).decode().rstrip("=")
    base = "\n".join([method, path, timestamp, nonce, call_type]).encode() + b"\n" + body
    signature = hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return {
        "X-Protocol-Version": "1.0",
        "X-Timestamp": timestamp,
        "X-Nonce": nonce,
        "X-Signature": signature,
        "X-Call-Type": call_type,
    }

# 调用方式：
headers = sign_request("POST", "/v1/callbacks/health", body=b'{"status":"ok"}', secret=AGENT_SIGNING_SECRET)
# 发起 HTTP POST，附加上述 headers 与相同的 body。
```

沙箱准入调用（[[15.agent-sandbox-admission]]）只需将 `call_type` 显式传 `"sandbox"`；生产调用省略该参数即可（默认 `production`）。

### 2.7 非功能约束（供 Agent 团队参考）

- 签名验证与幂等查重的单次开销不构成派发链路瓶颈（平台侧目标 P95 < 50ms），Agent 团队无需为此额外优化客户端。
- 签名密钥、Webhook 密钥不得以明文形式出现在日志中；Agent 团队自身实现也应遵循同等标准，避免在错误日志中回显 `X-Signature` 或密钥原文。
- 协议层与具体资金链无关（MVP 资金侧选定 Ethereum，但不影响本协议的实现方式）。

## 8. 未覆盖范围

以下内容不属于本协议层职责，Agent 团队接入时应参考对应 feature 的规格文档，不应假设本协议隐含相关规则：

- Agent 注册、凭证签发与加密存储流程（见 `specs/2.agent-registration`）。
- 沙箱准入的具体测试任务内容与人工判定标准（见 `specs/15.agent-sandbox-admission`）。
- 死信记录的表结构与重试上限之后的业务级处理决策（在 `specs/9.dispatch-and-acceptance` 中定义）。
