import { describe, expect, it } from "vitest";

import { parseCreateAgentInput } from "./create-agent-input";

function validInput() {
	return {
		name: "RAG Agent",
		categoryId: "11111111-1111-4111-8111-111111111111",
		capabilityDesc: "根据私有知识库回答问题并提供引用",
		tags: ["next.js"],
		pricingType: "fixed",
		price: { amount: "1000000", currency: "USDC" },
		walletAddress: "0x1111111111111111111111111111111111111111",
		payoutWalletAddress: "0x1111111111111111111111111111111111111111",
		serviceEndpoint: "https://agent.example.com/run",
		credentialSecret: "secret",
		email: "provider@example.com",
	};
}

describe("parseCreateAgentInput matching tags", () => {
	it("快速 HTTP 接入允许公开 Agent 不填访问密钥", () => {
		const input = validInput();
		delete (input as Partial<typeof input>).credentialSecret;

		const parsed = parseCreateAgentInput({
			...input,
			integrationMode: "http_json",
		});
		expect(parsed).toMatchObject({
			success: true,
			data: { integrationMode: "http_json" },
		});
		if (parsed.success) expect(parsed.data.credentialSecret).toBeUndefined();
	});

	it("历史客户端未声明模式时仍要求 HMAC 凭证", () => {
		const input = validInput();
		delete (input as Partial<typeof input>).credentialSecret;

		expect(parseCreateAgentInput(input)).toMatchObject({
			success: false,
			fieldErrors: [expect.objectContaining({ field: "credentialSecret" })],
		});
	});

	it("allows registration without a contact email", () => {
		const input = validInput();
		delete (input as Partial<typeof input>).email;

		const parsed = parseCreateAgentInput(input);
		expect(parsed).toMatchObject({ success: true });
		if (parsed.success) expect(parsed.data).not.toHaveProperty("email");
	});

	it("allows a new provider to register without portfolio cases", () => {
		expect(parseCreateAgentInput(validInput())).toMatchObject({
			success: true,
		});
	});

	it("normalizes and deduplicates platform and custom tags before persistence", () => {
		const parsed = parseCreateAgentInput({
			...validInput(),
			tags: [" Next.js ", "  RAG   Workflow  ", "rag workflow"],
		});

		expect(parsed).toMatchObject({
			success: true,
			data: { tags: ["next.js", "rag workflow"] },
		});
	});

	it("rejects unsafe delimiters and more than ten tags", () => {
		expect(
			parseCreateAgentInput({ ...validInput(), tags: ["design,code"] }),
		).toMatchObject({
			success: false,
			fieldErrors: [expect.objectContaining({ field: "tags.0" })],
		});
		expect(
			parseCreateAgentInput({
				...validInput(),
				tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`),
			}),
		).toMatchObject({
			success: false,
			fieldErrors: [expect.objectContaining({ field: "tags" })],
		});
	});

	it("rejects non-USDC quotes at the registration boundary", () => {
		expect(
			parseCreateAgentInput({
				...validInput(),
				price: { amount: "1000000", currency: "ETH" },
			}),
		).toMatchObject({
			success: false,
			fieldErrors: [expect.objectContaining({ field: "price.currency" })],
		});
	});

	it("rejects quotes below the one USDC business minimum", () => {
		expect(
			parseCreateAgentInput({
				...validInput(),
				price: { amount: "999999", currency: "USDC" },
			}),
		).toMatchObject({
			success: false,
			fieldErrors: [expect.objectContaining({ field: "price.amount" })],
		});
	});

	it("accepts up to three public portfolio cases and rejects unsafe preview addresses", () => {
		expect(
			parseCreateAgentInput({
				...validInput(),
				portfolioCases: [
					{
						title: "电商首页设计",
						summary: "包含桌面端与移动端的完整视觉稿。",
						artifactKind: "image",
						previewRef: "https://example.com/cases/storefront.png",
					},
				],
			}),
		).toMatchObject({ success: true });

		expect(
			parseCreateAgentInput({
				...validInput(),
				portfolioCases: [
					{
						title: "不安全案例",
						summary: "不允许把本地文件地址提交到公开候选证据。",
						artifactKind: "document",
						previewRef: "file:///tmp/private.pdf",
					},
				],
			}),
		).toMatchObject({
			success: false,
			fieldErrors: [
				expect.objectContaining({ field: "portfolioCases.0.previewRef" }),
			],
		});

		expect(
			parseCreateAgentInput({
				...validInput(),
				portfolioCases: Array.from({ length: 4 }, (_, index) => ({
					title: `案例 ${index + 1}`,
					summary: "用于验证案例数量上限。",
					artifactKind: "website",
					previewRef: `https://example.com/cases/${index + 1}`,
				})),
			}),
		).toMatchObject({
			success: false,
			fieldErrors: [expect.objectContaining({ field: "portfolioCases" })],
		});

		expect(
			parseCreateAgentInput({
				...validInput(),
				portfolioCases: [
					{
						title: "超长地址案例",
						summary:
							"应用层必须在写数据库前给出字段错误，不能依赖数据库约束返回 500。",
						artifactKind: "website",
						previewRef: `https://example.com/${"a".repeat(2000)}`,
					},
				],
			}),
		).toMatchObject({
			success: false,
			fieldErrors: [
				expect.objectContaining({ field: "portfolioCases.0.previewRef" }),
			],
		});
	});
});
