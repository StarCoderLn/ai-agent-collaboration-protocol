import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postLocalAgent } from "@/lib/agent-lab/server-client";
import { POST } from "./route";

vi.mock("@/lib/agent-lab/server-client", () => ({
	postLocalAgent: vi.fn(),
}));

const validInput = {
	topic: "Agent protocol reliability",
	researchQuestion: "How can independent agents recover from failures?",
	language: "en",
	targetWords: 700,
	sourceCount: 4,
};

describe("POST /api/agent-lab/research", () => {
	beforeEach(() => {
		vi.stubEnv("EVIDENCE_AGENT_URL", "http://127.0.0.1:9201/v1/research");
		vi.stubEnv("EVIDENCE_AGENT_SECRET", "route-handler-test-secret");
		vi.stubEnv("EVIDENCE_AGENT_REQUEST_TIMEOUT_MS", "960000");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	it("signs a sandbox protocol request and returns a validated report", async () => {
		vi.mocked(postLocalAgent).mockImplementationOnce(
			async (_endpoint, _headers, rawBody) => {
				const body = JSON.parse(Buffer.from(rawBody).toString("utf8")) as {
					taskId: string;
				};
				return {
					status: 200,
					body: {
						agentId: "evidence-research-agent",
						callType: "sandbox",
						result: validReport(body.taskId),
					},
				};
			},
		);

		const response = await POST(labRequest(validInput));
		const responseBody = (await response.json()) as {
			success: boolean;
			callType: string;
			result: { taskId: string };
		};

		expect(response.status).toBe(200);
		expect(responseBody).toMatchObject({
			success: true,
			callType: "sandbox",
			result: { taskId: expect.stringMatching(/^lab-/) },
		});
		expect(postLocalAgent).toHaveBeenCalledWith(
			new URL("http://127.0.0.1:9201/v1/research"),
			expect.objectContaining({
				"X-Protocol-Version": "1.0",
				"X-Call-Type": "sandbox",
				"X-Signature": expect.stringMatching(/^[0-9a-f]{64}$/),
			}),
			expect.any(Buffer),
			960_000,
		);
	});

	it("rejects an oversized Lab task before contacting the Agent", async () => {
		const response = await POST(
			labRequest({ ...validInput, targetWords: 5_000 }),
		);
		const responseBody = (await response.json()) as { code: string };

		expect(response.status).toBe(400);
		expect(responseBody.code).toBe("VALIDATION_FAILED");
		expect(postLocalAgent).not.toHaveBeenCalled();
	});

	it("maps a stopped local Agent to an actionable retryable error", async () => {
		vi.mocked(postLocalAgent).mockRejectedValueOnce(
			new TypeError("connection failed"),
		);

		const response = await POST(labRequest(validInput));
		const responseBody = (await response.json()) as {
			code: string;
			retryable: boolean;
		};

		expect(response.status).toBe(503);
		expect(responseBody).toEqual(
			expect.objectContaining({ code: "AGENT_UNAVAILABLE", retryable: true }),
		);
	});
});

function labRequest(body: unknown): Request {
	return new Request("http://localhost/api/agent-lab/research", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function validReport(taskId: string) {
	return {
		schemaVersion: "paper.report.v0.1",
		taskId,
		title: "Reliable agents",
		executiveSummary: "Summary",
		sections: [
			{ heading: "Evidence", content: "Findings", citationIds: ["source-1"] },
			{
				heading: "Conclusion",
				content: "Conclusion",
				citationIds: ["source-1"],
			},
		],
		sources: [
			{
				id: "source-1",
				title: "A source",
				authors: ["Researcher"],
				publicationYear: 2025,
				doi: null,
				url: "https://openalex.org/W1",
			},
		],
		limitations: ["Metadata only"],
		generatedAt: "2026-08-22T00:00:00.000Z",
	};
}
