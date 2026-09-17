/* 此文件由 scripts/generate-route-registry.mjs 生成，请勿手工编辑。 */
import type { RouteDefinition } from "../hono-route-adapter";
import * as route0 from "./agents/[id]/admission/retry/route";
import * as route1 from "./agents/[id]/credentials/route";
import * as route2 from "./agents/[id]/delist/route";
import * as route3 from "./agents/[id]/pause/route";
import * as route4 from "./agents/[id]/resume/route";
import * as route5 from "./agents/[id]/route";
import * as route6 from "./agents/[id]/score/route";
import * as route7 from "./agents/connection-test/route";
import * as route8 from "./agents/route";
import * as route9 from "./auth/nonce/route";
import * as route10 from "./auth/session/route";
import * as route11 from "./auth/verify/route";
import * as route12 from "./categories/route";
import * as route13 from "./dao/candidate-pool/route";
import * as route14 from "./dao/cases/[id]/actions/route";
import * as route15 from "./dao/cases/[id]/votes/route";
import * as route16 from "./dao/membership/sync/route";
import * as route17 from "./dao/rewards/route";
import * as route18 from "./dao/route";
import * as route19 from "./disputes/[id]/attachments/[objectId]/route";
import * as route20 from "./disputes/[id]/attachments/route";
import * as route21 from "./disputes/[id]/decision/route";
import * as route22 from "./disputes/[id]/evidence/route";
import * as route23 from "./disputes/[id]/route";
import * as route24 from "./health/route";
import * as route25 from "./internal/tasks/[id]/execution/results/route";
import * as route26 from "./internal/tasks/[id]/execution/status/route";
import * as route27 from "./internal/tasks/[id]/transitions/route";
import * as route28 from "./internal/tasks/[id]/workflow-nodes/[nodeId]/execution/results/route";
import * as route29 from "./internal/tasks/[id]/workflow-nodes/[nodeId]/execution/status/route";
import * as route30 from "./internal/tasks/[id]/workflow-nodes/[nodeId]/transitions/route";
import * as route31 from "./internal/webhook-deliveries/dead-letters/route";
import * as route32 from "./internal/workers/dao-cases/reconcile/route";
import * as route33 from "./internal/workers/dao-cases/retry/route";
import * as route34 from "./internal/workers/dao-cases/route";
import * as route35 from "./internal/workers/dao-rewards/reconcile/route";
import * as route36 from "./internal/workers/dao-rewards/route";
import * as route37 from "./internal/workers/escrow-execution/route";
import * as route38 from "./internal/workers/escrow-sync/route";
import * as route39 from "./internal/workers/execution-timeouts/route";
import * as route40 from "./internal/workers/score-refresh-requests/route";
import * as route41 from "./internal/workers/score-snapshots/route";
import * as route42 from "./market/agents/[id]/route";
import * as route43 from "./market/agents/route";
import * as route44 from "./market/stats/route";
import * as route45 from "./market/tasks/route";
import * as route46 from "./my-agents/route";
import * as route47 from "./my-tasks/route";
import * as route48 from "./my-tasks/stats/route";
import * as route49 from "./tags/suggest/route";
import * as route50 from "./tasks/[id]/accept/route";
import * as route51 from "./tasks/[id]/acceptance-preview/route";
import * as route52 from "./tasks/[id]/assignments/latest/route";
import * as route53 from "./tasks/[id]/assignments/route";
import * as route54 from "./tasks/[id]/candidate-exposures/route";
import * as route55 from "./tasks/[id]/candidates/route";
import * as route56 from "./tasks/[id]/disputes/route";
import * as route57 from "./tasks/[id]/escrow/prepare/route";
import * as route58 from "./tasks/[id]/escrow/retry/route";
import * as route59 from "./tasks/[id]/escrow/submission/route";
import * as route60 from "./tasks/[id]/escrow-status/route";
import * as route61 from "./tasks/[id]/events/stream/route";
import * as route62 from "./tasks/[id]/execution-retry/route";
import * as route63 from "./tasks/[id]/match-criteria/route";
import * as route64 from "./tasks/[id]/mode-settings/route";
import * as route65 from "./tasks/[id]/preview/route";
import * as route66 from "./tasks/[id]/rating/route";
import * as route67 from "./tasks/[id]/rematch/route";
import * as route68 from "./tasks/[id]/results/route";
import * as route69 from "./tasks/[id]/rework/route";
import * as route70 from "./tasks/[id]/route";
import * as route71 from "./tasks/[id]/status/route";
import * as route72 from "./tasks/[id]/submit/route";
import * as route73 from "./tasks/[id]/workflow/recommended-agents/route";
import * as route74 from "./tasks/[id]/workflow/route";
import * as route75 from "./tasks/[id]/workflow-feedback/route";
import * as route76 from "./tasks/[id]/workflow-nodes/[nodeId]/accept/route";
import * as route77 from "./tasks/[id]/workflow-nodes/[nodeId]/acceptance-preview/route";
import * as route78 from "./tasks/[id]/workflow-nodes/[nodeId]/assignments/latest/route";
import * as route79 from "./tasks/[id]/workflow-nodes/[nodeId]/assignments/route";
import * as route80 from "./tasks/[id]/workflow-nodes/[nodeId]/candidate-exposures/route";
import * as route81 from "./tasks/[id]/workflow-nodes/[nodeId]/candidates/route";
import * as route82 from "./tasks/[id]/workflow-nodes/[nodeId]/execution-retry/route";
import * as route83 from "./tasks/[id]/workflow-nodes/[nodeId]/feedback/route";
import * as route84 from "./tasks/[id]/workflow-nodes/[nodeId]/preferences/route";
import * as route85 from "./tasks/[id]/workflow-nodes/[nodeId]/rematch/route";
import * as route86 from "./tasks/[id]/workflow-nodes/[nodeId]/rework/route";
import * as route87 from "./tasks/[id]/workflow-plan/confirm/route";
import * as route88 from "./tasks/[id]/workflow-plan/generate/route";
import * as route89 from "./tasks/[id]/workflow-plan/route";
import * as route90 from "./tasks/route";
import * as route91 from "./wallet/assets/route";

export const routeDefinitions: readonly RouteDefinition[] = [
	{
		path: "/api/agents/:id/admission/retry",
		methods: ["POST", "OPTIONS"],
		module: route0,
	},
	{
		path: "/api/agents/:id/credentials",
		methods: ["PUT", "OPTIONS"],
		module: route1,
	},
	{
		path: "/api/agents/:id/delist",
		methods: ["POST", "OPTIONS"],
		module: route2,
	},
	{
		path: "/api/agents/:id/pause",
		methods: ["POST", "OPTIONS"],
		module: route3,
	},
	{
		path: "/api/agents/:id/resume",
		methods: ["POST", "OPTIONS"],
		module: route4,
	},
	{
		path: "/api/agents/:id",
		methods: ["GET", "PATCH", "OPTIONS"],
		module: route5,
	},
	{
		path: "/api/agents/:id/score",
		methods: ["GET", "OPTIONS"],
		module: route6,
	},
	{
		path: "/api/agents/connection-test",
		methods: ["POST", "OPTIONS"],
		module: route7,
	},
	{
		path: "/api/agents",
		methods: ["POST", "OPTIONS"],
		module: route8,
	},
	{
		path: "/api/auth/nonce",
		methods: ["GET"],
		module: route9,
	},
	{
		path: "/api/auth/session",
		methods: ["GET", "DELETE", "OPTIONS"],
		module: route10,
	},
	{
		path: "/api/auth/verify",
		methods: ["POST", "OPTIONS"],
		module: route11,
	},
	{
		path: "/api/categories",
		methods: ["GET", "OPTIONS"],
		module: route12,
	},
	{
		path: "/api/dao/candidate-pool",
		methods: ["GET", "OPTIONS"],
		module: route13,
	},
	{
		path: "/api/dao/cases/:id/actions",
		methods: ["POST", "OPTIONS"],
		module: route14,
	},
	{
		path: "/api/dao/cases/:id/votes",
		methods: ["POST", "OPTIONS"],
		module: route15,
	},
	{
		path: "/api/dao/membership/sync",
		methods: ["POST", "OPTIONS"],
		module: route16,
	},
	{
		path: "/api/dao/rewards",
		methods: ["GET", "PATCH", "OPTIONS"],
		module: route17,
	},
	{
		path: "/api/dao",
		methods: ["GET", "OPTIONS"],
		module: route18,
	},
	{
		path: "/api/disputes/:id/attachments/:objectId",
		methods: ["GET", "OPTIONS"],
		module: route19,
	},
	{
		path: "/api/disputes/:id/attachments",
		methods: ["POST", "OPTIONS"],
		module: route20,
	},
	{
		path: "/api/disputes/:id/decision",
		methods: ["POST", "OPTIONS"],
		module: route21,
	},
	{
		path: "/api/disputes/:id/evidence",
		methods: ["POST", "OPTIONS"],
		module: route22,
	},
	{
		path: "/api/disputes/:id",
		methods: ["GET", "OPTIONS"],
		module: route23,
	},
	{
		path: "/api/health",
		methods: ["GET"],
		module: route24,
	},
	{
		path: "/api/internal/tasks/:id/execution/results",
		methods: ["POST"],
		module: route25,
	},
	{
		path: "/api/internal/tasks/:id/execution/status",
		methods: ["POST"],
		module: route26,
	},
	{
		path: "/api/internal/tasks/:id/transitions",
		methods: ["POST"],
		module: route27,
	},
	{
		path: "/api/internal/tasks/:id/workflow-nodes/:nodeId/execution/results",
		methods: ["POST"],
		module: route28,
	},
	{
		path: "/api/internal/tasks/:id/workflow-nodes/:nodeId/execution/status",
		methods: ["POST"],
		module: route29,
	},
	{
		path: "/api/internal/tasks/:id/workflow-nodes/:nodeId/transitions",
		methods: ["POST"],
		module: route30,
	},
	{
		path: "/api/internal/webhook-deliveries/dead-letters",
		methods: ["GET"],
		module: route31,
	},
	{
		path: "/api/internal/workers/dao-cases/reconcile",
		methods: ["POST"],
		module: route32,
	},
	{
		path: "/api/internal/workers/dao-cases/retry",
		methods: ["POST"],
		module: route33,
	},
	{
		path: "/api/internal/workers/dao-cases",
		methods: ["POST"],
		module: route34,
	},
	{
		path: "/api/internal/workers/dao-rewards/reconcile",
		methods: ["POST"],
		module: route35,
	},
	{
		path: "/api/internal/workers/dao-rewards",
		methods: ["POST"],
		module: route36,
	},
	{
		path: "/api/internal/workers/escrow-execution",
		methods: ["POST"],
		module: route37,
	},
	{
		path: "/api/internal/workers/escrow-sync",
		methods: ["POST"],
		module: route38,
	},
	{
		path: "/api/internal/workers/execution-timeouts",
		methods: ["POST"],
		module: route39,
	},
	{
		path: "/api/internal/workers/score-refresh-requests",
		methods: ["POST"],
		module: route40,
	},
	{
		path: "/api/internal/workers/score-snapshots",
		methods: ["POST"],
		module: route41,
	},
	{
		path: "/api/market/agents/:id",
		methods: ["GET", "OPTIONS"],
		module: route42,
	},
	{
		path: "/api/market/agents",
		methods: ["GET", "OPTIONS"],
		module: route43,
	},
	{
		path: "/api/market/stats",
		methods: ["GET", "OPTIONS"],
		module: route44,
	},
	{
		path: "/api/market/tasks",
		methods: ["GET", "OPTIONS"],
		module: route45,
	},
	{
		path: "/api/my-agents",
		methods: ["GET", "OPTIONS"],
		module: route46,
	},
	{
		path: "/api/my-tasks",
		methods: ["GET", "OPTIONS"],
		module: route47,
	},
	{
		path: "/api/my-tasks/stats",
		methods: ["GET", "OPTIONS"],
		module: route48,
	},
	{
		path: "/api/tags/suggest",
		methods: ["GET", "OPTIONS"],
		module: route49,
	},
	{
		path: "/api/tasks/:id/accept",
		methods: ["POST", "OPTIONS"],
		module: route50,
	},
	{
		path: "/api/tasks/:id/acceptance-preview",
		methods: ["GET", "OPTIONS"],
		module: route51,
	},
	{
		path: "/api/tasks/:id/assignments/latest",
		methods: ["GET", "OPTIONS"],
		module: route52,
	},
	{
		path: "/api/tasks/:id/assignments",
		methods: ["POST", "OPTIONS"],
		module: route53,
	},
	{
		path: "/api/tasks/:id/candidate-exposures",
		methods: ["POST", "OPTIONS"],
		module: route54,
	},
	{
		path: "/api/tasks/:id/candidates",
		methods: ["GET", "OPTIONS"],
		module: route55,
	},
	{
		path: "/api/tasks/:id/disputes",
		methods: ["POST", "OPTIONS"],
		module: route56,
	},
	{
		path: "/api/tasks/:id/escrow/prepare",
		methods: ["POST", "OPTIONS"],
		module: route57,
	},
	{
		path: "/api/tasks/:id/escrow/retry",
		methods: ["POST", "OPTIONS"],
		module: route58,
	},
	{
		path: "/api/tasks/:id/escrow/submission",
		methods: ["POST", "OPTIONS"],
		module: route59,
	},
	{
		path: "/api/tasks/:id/escrow-status",
		methods: ["GET", "OPTIONS"],
		module: route60,
	},
	{
		path: "/api/tasks/:id/events/stream",
		methods: ["GET", "OPTIONS"],
		module: route61,
	},
	{
		path: "/api/tasks/:id/execution-retry",
		methods: ["POST"],
		module: route62,
	},
	{
		path: "/api/tasks/:id/match-criteria",
		methods: ["PATCH", "OPTIONS"],
		module: route63,
	},
	{
		path: "/api/tasks/:id/mode-settings",
		methods: ["PATCH", "OPTIONS"],
		module: route64,
	},
	{
		path: "/api/tasks/:id/preview",
		methods: ["GET", "OPTIONS"],
		module: route65,
	},
	{
		path: "/api/tasks/:id/rating",
		methods: ["POST", "OPTIONS"],
		module: route66,
	},
	{
		path: "/api/tasks/:id/rematch",
		methods: ["POST", "OPTIONS"],
		module: route67,
	},
	{
		path: "/api/tasks/:id/results",
		methods: ["GET", "OPTIONS"],
		module: route68,
	},
	{
		path: "/api/tasks/:id/rework",
		methods: ["POST", "OPTIONS"],
		module: route69,
	},
	{
		path: "/api/tasks/:id",
		methods: ["GET", "PATCH", "DELETE", "OPTIONS"],
		module: route70,
	},
	{
		path: "/api/tasks/:id/status",
		methods: ["GET", "OPTIONS"],
		module: route71,
	},
	{
		path: "/api/tasks/:id/submit",
		methods: ["POST", "OPTIONS"],
		module: route72,
	},
	{
		path: "/api/tasks/:id/workflow/recommended-agents",
		methods: ["POST", "OPTIONS"],
		module: route73,
	},
	{
		path: "/api/tasks/:id/workflow",
		methods: ["GET", "PATCH", "OPTIONS"],
		module: route74,
	},
	{
		path: "/api/tasks/:id/workflow-feedback",
		methods: ["GET", "OPTIONS"],
		module: route75,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/accept",
		methods: ["POST", "OPTIONS"],
		module: route76,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/acceptance-preview",
		methods: ["GET", "OPTIONS"],
		module: route77,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/assignments/latest",
		methods: ["GET", "OPTIONS"],
		module: route78,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/assignments",
		methods: ["POST", "OPTIONS"],
		module: route79,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/candidate-exposures",
		methods: ["POST", "OPTIONS"],
		module: route80,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/candidates",
		methods: ["GET", "OPTIONS"],
		module: route81,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/execution-retry",
		methods: ["POST", "OPTIONS"],
		module: route82,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/feedback",
		methods: ["POST", "OPTIONS"],
		module: route83,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/preferences",
		methods: ["PATCH", "OPTIONS"],
		module: route84,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/rematch",
		methods: ["POST", "OPTIONS"],
		module: route85,
	},
	{
		path: "/api/tasks/:id/workflow-nodes/:nodeId/rework",
		methods: ["POST", "OPTIONS"],
		module: route86,
	},
	{
		path: "/api/tasks/:id/workflow-plan/confirm",
		methods: ["POST", "OPTIONS"],
		module: route87,
	},
	{
		path: "/api/tasks/:id/workflow-plan/generate",
		methods: ["POST", "OPTIONS"],
		module: route88,
	},
	{
		path: "/api/tasks/:id/workflow-plan",
		methods: ["GET", "PUT", "OPTIONS"],
		module: route89,
	},
	{
		path: "/api/tasks",
		methods: ["POST", "OPTIONS"],
		module: route90,
	},
	{
		path: "/api/wallet/assets",
		methods: ["GET", "OPTIONS"],
		module: route91,
	},
];
