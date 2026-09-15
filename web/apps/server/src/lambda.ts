import { handle } from "hono/aws-lambda";
import { app } from "./app";

/** AWS Lambda 只做事件到标准 Request/Response 的转换，全部 HTTP 与业务规则由 Hono app 承担。 */
export const handler = handle(app);
