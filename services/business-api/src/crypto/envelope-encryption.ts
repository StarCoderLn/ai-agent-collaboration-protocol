/**
 * 信封加密工具（2.agent-registration T-002）。
 *
 * 契约：本模块只暴露"加密/覆盖写"路径，不导出任何解密函数——
 * 凭证一旦加密落库即不可再被本服务读出明文（design.md 模块2：
 * "接口层面直接不存在'读明文'这个操作，用契约消除误用可能，而非靠权限控制兜底"）。
 * 如果未来出现真实的解密需求（如迁移密钥），必须在高影响决策摘要中说明用途、
 * 审批与审计方式后另行设计，不得在此文件内偷偷加回 decrypt 函数。
 *
 * 加密流程（信封加密）：
 * 1. 调用 AWS KMS GenerateDataKey 获取一次性数据密钥（明文 + KMS 密文两种形式）。
 * 2. 用数据密钥明文在本地对凭证明文做 AES-256-GCM 加密。
 * 3. 落库内容只包含 KMS 加密后的数据密钥密文 + IV + authTag + 密文本体，
 *    数据密钥明文全程不持久化，使用后尽快清零。
 */

import { randomBytes, createCipheriv } from "node:crypto";
import {
  KMSClient,
  GenerateDataKeyCommand,
  type GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";

/** 兼容未来格式演进的打包版本号；当前只有 1 个版本。 */
const PACKED_FORMAT_VERSION = 1;

const AES_KEY_SPEC = "AES_256" as const;
const GCM_IV_LENGTH_BYTES = 12;
const GCM_AUTH_TAG_LENGTH_BYTES = 16;

/** 精简的 KMS 客户端接口，便于测试注入 fake 实现，不依赖真实 AWS 凭据。 */
export interface KmsLike {
  send(command: GenerateDataKeyCommand): Promise<GenerateDataKeyCommandOutput>;
}

export interface EnvelopeEncryptorConfig {
  /** KMS CMK 的 Key ID 或 Alias（如 `alias/agent-credentials`）。 */
  kmsKeyId: string;
  /**
   * 数据密钥本地缓存 TTL（毫秒）。风险点：KMS 调用延迟可能拖累注册接口 P95。
   * 缓存的是数据密钥本身（用于本地对称加密），绝不缓存凭证明文。
   * 设为 0 关闭缓存，每次加密都重新调用 KMS。默认 5 分钟。
   */
  dataKeyCacheTtlMs?: number;
}

export interface EncryptCredentialResult {
  /** 落库的不透明密文（base64），写入 agent_credentials.encrypted_secret。 */
  encryptedSecret: string;
  /** 本次加密使用的 KMS Key ID，便于审计与未来密钥轮换排查。 */
  kmsKeyId: string;
}

interface CachedDataKey {
  plaintext: Buffer;
  encryptedBlob: Buffer;
  keyId: string;
  expiresAt: number;
}

interface DataKeyLease {
  plaintext: Buffer;
  encryptedBlob: Buffer;
  keyId: string;
}

const DEFAULT_DATA_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 面向单个 KMS CMK 的信封加密器。同一进程内可复用同一实例以启用数据密钥缓存。
 */
export class EnvelopeEncryptor {
  private readonly kms: KmsLike;
  private readonly kmsKeyId: string;
  private readonly cacheTtlMs: number;
  private cachedDataKey: CachedDataKey | undefined;
  private cacheExpiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(config: EnvelopeEncryptorConfig, kmsClient?: KmsLike) {
    if (!config.kmsKeyId) {
      throw new Error("EnvelopeEncryptor: kmsKeyId 不能为空");
    }
    this.kmsKeyId = config.kmsKeyId;
    this.cacheTtlMs = config.dataKeyCacheTtlMs ?? DEFAULT_DATA_KEY_CACHE_TTL_MS;
    this.kms = kmsClient ?? new KMSClient({});
  }

  /**
   * 加密凭证明文，返回可直接落库的密文。调用方（T-005）负责整体替换写入
   * `agent_credentials.encrypted_secret` 并递增 `key_version`，本函数不接触数据库。
   */
  async encryptCredential(plaintextSecret: string): Promise<EncryptCredentialResult> {
    if (plaintextSecret.length === 0) {
      throw new Error("EnvelopeEncryptor: 凭证明文不能为空");
    }

    const dataKey = await this.getDataKeyLease();
    try {
      const iv = randomBytes(GCM_IV_LENGTH_BYTES);
      const cipher = createCipheriv("aes-256-gcm", dataKey.plaintext, iv, {
        authTagLength: GCM_AUTH_TAG_LENGTH_BYTES,
      });

      const ciphertext = Buffer.concat([
        cipher.update(plaintextSecret, "utf8"),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      const encryptedSecret = packEnvelope({
        encryptedDataKey: dataKey.encryptedBlob,
        iv,
        authTag,
        ciphertext,
      });

      return { encryptedSecret, kmsKeyId: dataKey.keyId };
    } finally {
      // 每个调用只使用自己的明文副本；完成后立即清零，缓存本体由独立定时器按 TTL 清零。
      dataKey.plaintext.fill(0);
    }
  }

  /** 获取调用级密钥副本，避免一个请求清零缓存时破坏另一个并发请求正在使用的密钥。 */
  private async getDataKeyLease(): Promise<DataKeyLease> {
    const now = Date.now();
    if (this.cachedDataKey && this.cachedDataKey.expiresAt > now) {
      return cloneDataKey(this.cachedDataKey);
    }

    this.clearCachedDataKey();

    const response = await this.kms.send(
      new GenerateDataKeyCommand({ KeyId: this.kmsKeyId, KeySpec: AES_KEY_SPEC }),
    );
    if (!response.Plaintext || !response.CiphertextBlob || !response.KeyId) {
      throw new Error("EnvelopeEncryptor: KMS GenerateDataKey 返回缺少 Plaintext/CiphertextBlob/KeyId");
    }

    const next: CachedDataKey = {
      plaintext: Buffer.from(response.Plaintext),
      encryptedBlob: Buffer.from(response.CiphertextBlob),
      keyId: response.KeyId,
      expiresAt: this.cacheTtlMs > 0 ? now + this.cacheTtlMs : now,
    };

    if (this.cacheTtlMs > 0) {
      this.cachedDataKey = next;
      this.cacheExpiryTimer = setTimeout(() => {
        if (this.cachedDataKey === next) {
          this.clearCachedDataKey();
        }
      }, this.cacheTtlMs);
      this.cacheExpiryTimer.unref?.();
      return cloneDataKey(next);
    } else {
      const lease = cloneDataKey(next);
      next.plaintext.fill(0);
      return lease;
    }
  }

  private clearCachedDataKey(): void {
    if (this.cacheExpiryTimer) {
      clearTimeout(this.cacheExpiryTimer);
      this.cacheExpiryTimer = undefined;
    }
    if (this.cachedDataKey) {
      this.cachedDataKey.plaintext.fill(0);
      this.cachedDataKey = undefined;
    }
  }
}

function cloneDataKey(dataKey: CachedDataKey): DataKeyLease {
  return {
    plaintext: Buffer.from(dataKey.plaintext),
    encryptedBlob: Buffer.from(dataKey.encryptedBlob),
    keyId: dataKey.keyId,
  };
}

interface EnvelopeParts {
  encryptedDataKey: Buffer;
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

/**
 * 打包格式（均为大端序）：
 * [1B formatVersion][4B encryptedDataKeyLength][encryptedDataKey]
 * [12B iv][16B authTag][ciphertext...]
 * 整体再做 base64，得到落库的不透明字符串。
 */
function packEnvelope(parts: EnvelopeParts): string {
  const header = Buffer.alloc(5);
  header.writeUInt8(PACKED_FORMAT_VERSION, 0);
  header.writeUInt32BE(parts.encryptedDataKey.length, 1);

  return Buffer.concat([
    header,
    parts.encryptedDataKey,
    parts.iv,
    parts.authTag,
    parts.ciphertext,
  ]).toString("base64");
}
