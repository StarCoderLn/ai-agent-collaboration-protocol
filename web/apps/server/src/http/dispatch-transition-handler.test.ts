import { describe, expect, it, vi } from "vitest";

import {
	type AppliedDispatchTransition,
	DispatchTransitionError,
} from "../tasks/dispatch-transition";
import {
	createDispatchTransitionHandler,
	type DispatchTransitionHttpDeps,
} from "./dispatch-transition-handler";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const ASSIGNMENT_ID = "33333333-3333-4333-8333-333333333333";

function dependencies(
	overrides: Partial<DispatchTransitionHttpDeps> = {},
): DispatchTransitionHttpDeps {
	return {
		internalToken: "service-secret",
		apply: vi.fn(
			async (taskId): Promise<AppliedDispatchTransition> => ({
				eventId: EVENT_ID,
				taskId,
				assignmentId: ASSIGNMENT_ID,
				eventType: "assignment_locked",
				status: "awaiting_agent_acceptance",
				statusVersion: 4n,
				replayed: false,
			}),
		),
		...overrides,
	};
}

function request(
	token = "service-secret",
	body: unknown = {
		eventId: EVENT_ID,
		assignmentId: ASSIGNMENT_ID,
		eventType: "assignment_locked",
	},
): Request {
	return new Request(
		`http://api.local/api/internal/tasks/${TASK_ID}/transitions`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
	);
}

describe("dispatch transition internal handler", () => {
	it("rejects missing or wrong service credentials before touching the domain", async () => {
		const deps = dependencies();
		const response = await createDispatchTransitionHandler(deps)(
			request("wrong"),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(401);
		expect(deps.apply).not.toHaveBeenCalled();
	});

	it("serializes bigint versions without exposing an unsafe JSON number", async () => {
		const response = await createDispatchTransitionHandler(dependencies())(
			request(),
			{ params: Promise.resolve({ id: TASK_ID }) },
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "awaiting_agent_acceptance",
			statusVersion: "4",
		});
	});

	it("rejects malformed identifiers and bodies", async () => {
		const handler = createDispatchTransitionHandler(
			dependencies({
				apply: async () => {
					throw new DispatchTransitionError(
						"VALIDATION_FAILED",
						"bad input",
						422,
						false,
					);
				},
			}),
		);
		expect(
			(
				await handler(request(), {
					params: Promise.resolve({ id: "not-a-task" }),
				})
			).status,
		).toBe(404);
		expect(
			(
				await handler(
					request("service-secret", { eventType: "assignment_locked" }),
					{ params: Promise.resolve({ id: TASK_ID }) },
				)
			).status,
		).toBe(422);
	});
});
