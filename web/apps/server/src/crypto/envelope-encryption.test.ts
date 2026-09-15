import { randomBytes } from "node:crypto";
import type {
	GenerateDataKeyCommand,
	GenerateDataKeyCommandOutput,
} from "@aws-sdk/client-kms";
import { describe, expect, it, vi } from "vitest";
import {
	EnvelopeEncryptor,
	type KmsLike,
	kmsClientConfigFromEnvironment,
} from "./envelope-encryption.js";

function makeFakeKms(overrides?: Partial<GenerateDataKeyCommandOutput>): {
	kms: KmsLike;
	send: ReturnType<typeof vi.fn>;
} {
	const send = vi.fn(async (_command: GenerateDataKeyCommand) => {
		return {
			Plaintext: randomBytes(32),
			CiphertextBlob: randomBytes(48),
			KeyId: "test-key",
			$metadata: {},
			...overrides,
		} satisfies GenerateDataKeyCommandOutput;
	});
	return { kms: { send }, send };
}

describe("EnvelopeEncryptor", () => {
	it("仅在 LocalStack 模式向 AWS SDK 注入经过校验的 endpoint", () => {
		vi.stubEnv("AWS_ENDPOINT_URL", "");
		expect(kmsClientConfigFromEnvironment()).toEqual({});

		vi.stubEnv("AWS_ENDPOINT_URL", "http://127.0.0.1:4566/");
		expect(kmsClientConfigFromEnvironment()).toEqual({
			endpoint: "http://127.0.0.1:4566",
		});

		vi.stubEnv("AWS_ENDPOINT_URL", "file:///tmp/not-an-aws-endpoint");
		expect(() => kmsClientConfigFromEnvironment()).toThrow(/HTTP/);
		vi.unstubAllEnvs();
	});

	it("encrypts credential secret into an opaque base64 blob distinct from plaintext", async () => {
		const { kms } = makeFakeKms();
		const encryptor = new EnvelopeEncryptor(
			{ kmsKeyId: "alias/agent-credentials" },
			kms,
		);

		const result = await encryptor.encryptCredential("super-secret-api-key");

		expect(result.kmsKeyId).toBe("test-key");
		expect(result.encryptedSecret).not.toContain("super-secret-api-key");
		expect(
			Buffer.from(result.encryptedSecret, "base64").length,
		).toBeGreaterThan(0);
	});

	it("produces different ciphertext each call even for the same plaintext (unique IV)", async () => {
		const { kms } = makeFakeKms();
		const encryptor = new EnvelopeEncryptor(
			{ kmsKeyId: "alias/agent-credentials" },
			kms,
		);

		const first = await encryptor.encryptCredential("same-secret");
		const second = await encryptor.encryptCredential("same-secret");

		expect(first.encryptedSecret).not.toBe(second.encryptedSecret);
	});

	it("does not export any decrypt capability", async () => {
		const module = await import("./envelope-encryption.js");
		const exportNames = Object.keys(module);
		expect(exportNames.some((name) => /decrypt/i.test(name))).toBe(false);
	});

	it("rejects empty plaintext secrets", async () => {
		const { kms } = makeFakeKms();
		const encryptor = new EnvelopeEncryptor(
			{ kmsKeyId: "alias/agent-credentials" },
			kms,
		);

		await expect(encryptor.encryptCredential("")).rejects.toThrow(/不能为空/);
	});

	it("throws when constructed without a kmsKeyId", () => {
		const { kms } = makeFakeKms();
		expect(() => new EnvelopeEncryptor({ kmsKeyId: "" }, kms)).toThrow(
			/kmsKeyId/,
		);
	});

	it("reuses cached data key within TTL, avoiding a second KMS call", async () => {
		const { kms, send } = makeFakeKms();
		const encryptor = new EnvelopeEncryptor(
			{ kmsKeyId: "alias/agent-credentials", dataKeyCacheTtlMs: 60_000 },
			kms,
		);

		await encryptor.encryptCredential("secret-1");
		await encryptor.encryptCredential("secret-2");

		expect(send).toHaveBeenCalledTimes(1);
	});

	it("calls KMS again for every encryption when caching is disabled (ttl = 0)", async () => {
		const { kms, send } = makeFakeKms();
		const encryptor = new EnvelopeEncryptor(
			{ kmsKeyId: "alias/agent-credentials", dataKeyCacheTtlMs: 0 },
			kms,
		);

		await encryptor.encryptCredential("secret-1");
		await encryptor.encryptCredential("secret-2");

		expect(send).toHaveBeenCalledTimes(2);
	});

	it("clears an expired cached key on time without waiting for another request", async () => {
		vi.useFakeTimers();
		try {
			const plaintext = Buffer.alloc(32, 7);
			const { kms } = makeFakeKms({ Plaintext: plaintext });
			const encryptor = new EnvelopeEncryptor(
				{ kmsKeyId: "alias/agent-credentials", dataKeyCacheTtlMs: 50 },
				kms,
			);

			await encryptor.encryptCredential("secret");
			await vi.advanceTimersByTimeAsync(50);

			const cache = (
				encryptor as unknown as { cachedDataKey?: { plaintext: Buffer } }
			).cachedDataKey;
			expect(cache).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("surfaces a clear error when KMS response is missing Plaintext/CiphertextBlob", async () => {
		const send = vi.fn(async (_command: GenerateDataKeyCommand) => ({
			KeyId: "test-key",
			$metadata: {},
		}));
		const encryptor = new EnvelopeEncryptor(
			{ kmsKeyId: "alias/agent-credentials" },
			{ send },
		);

		await expect(encryptor.encryptCredential("secret")).rejects.toThrow(
			/GenerateDataKey/,
		);
	});
});
