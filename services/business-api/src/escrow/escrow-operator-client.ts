import { JsonRpcProvider, keccak256 } from "ethers";

import { encodeRefundCall, encodeReleaseCall } from "./escrow-chain-client";

export type EscrowOperatorJob = Readonly<{
  taskKey: string;
  contractAddress: string;
  action: "release" | "refund";
  payee: string | null;
  agentGrossAmountWei: bigint | null;
  feeAmountWei: bigint | null;
}>;

export type PreparedOperatorTransaction = Readonly<{ txHash: string; rawTransaction: string }>;

export interface EscrowOperatorClient {
  prepare(job: EscrowOperatorJob): Promise<PreparedOperatorTransaction>;
  broadcast(transaction: PreparedOperatorTransaction): Promise<string>;
}

/**
 * 仅供 Anvil/本地节点使用：让节点内置的解锁账户签名，再持久化 raw transaction 后广播。
 * 生产环境禁止启用此模式，必须替换为 KMS/HSM 实现；接口刻意不接受 privateKey。
 */
export class LocalUnlockedEscrowOperatorClient implements EscrowOperatorClient {
  constructor(private readonly provider: JsonRpcProvider, private readonly operatorAddress: string) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(operatorAddress)) throw new Error("INVALID_ESCROW_OPERATOR_ADDRESS");
  }

  async prepare(job: EscrowOperatorJob): Promise<PreparedOperatorTransaction> {
    const data = job.action === "refund"
      ? encodeRefundCall(job.taskKey)
      : encodeReleaseCall(
        job.taskKey,
        required(job.payee, "RELEASE_PAYEE_REQUIRED"),
        required(job.agentGrossAmountWei, "RELEASE_GROSS_REQUIRED"),
        required(job.feeAmountWei, "RELEASE_FEE_REQUIRED"),
      );
    const from = this.operatorAddress.toLowerCase();
    const transaction = { from, to: job.contractAddress, data, value: "0x0" };
    const [network, nonce, gas, fees] = await Promise.all([
      this.provider.getNetwork(),
      this.provider.getTransactionCount(from, "pending"),
      this.provider.estimateGas(transaction),
      this.provider.getFeeData(),
    ]);
    const request: Record<string, string> = {
      ...transaction,
      chainId: toQuantity(network.chainId),
      nonce: toQuantity(BigInt(nonce)),
      gas: toQuantity(gas),
    };
    if (fees.maxFeePerGas !== null && fees.maxPriorityFeePerGas !== null) {
      request.type = "0x2";
      request.maxFeePerGas = toQuantity(fees.maxFeePerGas);
      request.maxPriorityFeePerGas = toQuantity(fees.maxPriorityFeePerGas);
    } else if (fees.gasPrice !== null) {
      request.gasPrice = toQuantity(fees.gasPrice);
    } else {
      throw new Error("RPC_FEE_DATA_UNAVAILABLE");
    }
    const signed = await this.provider.send("eth_signTransaction", [request]);
    const rawTransaction = extractRawTransaction(signed);
    return { rawTransaction, txHash: keccak256(rawTransaction) };
  }

  async broadcast(transaction: PreparedOperatorTransaction): Promise<string> {
    try {
      const response = await this.provider.broadcastTransaction(transaction.rawTransaction);
      if (response.hash.toLowerCase() !== transaction.txHash) throw new Error("BROADCAST_HASH_MISMATCH");
      return response.hash.toLowerCase();
    } catch (error) {
      // 广播成功后响应丢失或 worker 重启时，重发同一 raw tx 可能返回 already known；
      // txHash 由签名交易本身确定，因此这种错误等价于幂等成功。
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (message.includes("already known") || message.includes("known transaction")) return transaction.txHash;
      throw error;
    }
  }
}

export function createLocalUnlockedOperatorClient(rpcUrl: string, chainId: bigint, operatorAddress: string): EscrowOperatorClient {
  return new LocalUnlockedEscrowOperatorClient(new JsonRpcProvider(rpcUrl, Number(chainId), { staticNetwork: true }), operatorAddress);
}

function extractRawTransaction(value: unknown): string {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return value.toLowerCase();
  if (typeof value === "object" && value !== null && "raw" in value && typeof value.raw === "string" && /^0x[0-9a-fA-F]+$/.test(value.raw)) {
    return value.raw.toLowerCase();
  }
  throw new Error("RPC_SIGN_TRANSACTION_INVALID");
}
function toQuantity(value: bigint): string { return `0x${value.toString(16)}`; }
function required<T>(value: T | null, code: string): T {
  if (value === null) throw new Error(code);
  return value;
}
