/**
 * 论文 Agent 保留原导入路径以兼容示例和测试，协议计算则统一委托给 SDK。新增 Agent
 * 不应再复制本文件，而应直接从 @aicp/agent-sdk 导入。
 */
export {
  computeSignature,
  MemoryNonceStore,
  PROTOCOL_VERSION,
  ProtocolError,
  ProtocolVerifier,
  protocolHeaders,
  signRequest,
  signatureBase,
  type CallType,
  type ProtocolErrorCode,
  type SignedHeaders,
  type SignedRequest,
  type VerifyInput,
} from "@aicp/agent-sdk";
