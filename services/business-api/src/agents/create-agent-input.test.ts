import { describe, expect, it } from "vitest";

import { parseCreateAgentInput } from "./create-agent-input";

function validInput() {
  return {
    name: "RAG Agent",
    categoryId: "11111111-1111-4111-8111-111111111111",
    capabilityDesc: "根据私有知识库回答问题并提供引用",
    tags: ["next.js"],
    pricingType: "fixed",
    price: { amount: "1000", currency: "ETH" },
    walletAddress: "0x1111111111111111111111111111111111111111",
    payoutWalletAddress: "0x1111111111111111111111111111111111111111",
    serviceEndpoint: "https://agent.example.com/run",
    credentialSecret: "secret",
    email: "provider@example.com",
  };
}

describe("parseCreateAgentInput matching tags", () => {
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
    expect(parseCreateAgentInput({ ...validInput(), tags: ["design,code"] })).toMatchObject({
      success: false,
      fieldErrors: [expect.objectContaining({ field: "tags.0" })],
    });
    expect(parseCreateAgentInput({
      ...validInput(),
      tags: Array.from({ length: 11 }, (_, index) => `tag-${index}`),
    })).toMatchObject({
      success: false,
      fieldErrors: [expect.objectContaining({ field: "tags" })],
    });
  });
});
