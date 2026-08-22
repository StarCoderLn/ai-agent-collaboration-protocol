import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { signSandboxRequest } from "./server-protocol";

type SignatureVector = {
	secret: string;
	method: "POST";
	path: string;
	timestamp: string;
	nonce: string;
	call_type: "sandbox";
	body: string;
	signature: string;
};

describe("Agent Lab protocol signer", () => {
	it("matches the shared protocol v1.0 signature vector", async () => {
		const vector = JSON.parse(
			await readFile(
				resolve(
					process.cwd(),
					"../../../docs/protocol-test-vectors/signature-v1.json",
				),
				"utf8",
			),
		) as SignatureVector;

		const headers = signSandboxRequest(
			{
				method: vector.method,
				path: vector.path,
				body: Buffer.from(vector.body),
			},
			vector.secret,
			{
				now: new Date(Number(vector.timestamp) * 1_000),
				nonce: vector.nonce,
			},
		);

		expect(headers).toMatchObject({
			"X-Protocol-Version": "1.0",
			"X-Call-Type": vector.call_type,
			"X-Signature": vector.signature,
		});
	});
});
