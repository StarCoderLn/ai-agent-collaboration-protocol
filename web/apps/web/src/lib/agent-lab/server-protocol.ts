import { createHmac, randomBytes } from "node:crypto";

const PROTOCOL_VERSION = "1.0";

type SandboxSigningInput = {
	method: "POST";
	path: string;
	body: Uint8Array;
};

/**
 * 为 Agent Lab 构造协议 v1.0 沙箱请求头。
 *
 * 此模块只能由 Route Handler 引用。签名覆盖原始 body 字节，调用方在签名后不得再次
 * JSON.stringify；否则即使 JSON 语义相同，Agent 也会正确地拒绝签名。
 */
export function signSandboxRequest(
	input: SandboxSigningInput,
	secret: string,
	options: { now?: Date; nonce?: string } = {},
): Record<string, string> {
	if (secret.length < 16) {
		throw new Error(
			"EVIDENCE_AGENT_SECRET must contain at least 16 characters",
		);
	}
	const timestamp = Math.floor(
		(options.now ?? new Date()).getTime() / 1_000,
	).toString();
	const nonce = options.nonce ?? randomBytes(16).toString("base64url");
	const callType = "sandbox";
	const base = Buffer.concat([
		Buffer.from(
			`${input.method}\n${input.path}\n${timestamp}\n${nonce}\n${callType}\n`,
			"utf8",
		),
		Buffer.from(input.body),
	]);
	const signature = createHmac("sha256", secret).update(base).digest("hex");

	return {
		"X-Protocol-Version": PROTOCOL_VERSION,
		"X-Timestamp": timestamp,
		"X-Nonce": nonce,
		"X-Signature": signature,
		"X-Call-Type": callType,
	};
}
