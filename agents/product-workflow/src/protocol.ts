/**
 * 产品工作流不再维护 AICP 签名算法的私有副本。保留这个兼容出口是为了让现有业务模块
 * 和测试逐步迁移；真正的协议权威实现位于 @aicp/agent-sdk。
 */
export {
  PROTOCOL_VERSION,
  ProtocolError,
  ProtocolVerifier,
  protocolHeaders,
  signRequest,
  type CallType,
} from "@aicp/agent-sdk";
