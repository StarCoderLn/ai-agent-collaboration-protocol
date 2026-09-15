import { createWebhookDeadLetterHandler } from "@server/http/webhook-dead-letter-handler";
import { createProductionWebhookDeadLetterDeps } from "@server/http/webhook-dead-letter-production-deps";

let handler: ReturnType<typeof createWebhookDeadLetterHandler> | undefined;

export function GET(request: Request): Promise<Response> {
	handler ??= createWebhookDeadLetterHandler(
		createProductionWebhookDeadLetterDeps(),
	);
	return handler(request);
}
