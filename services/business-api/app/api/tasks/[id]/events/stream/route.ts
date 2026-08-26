// 保留 `/events` 兼容早期体验客户端；正式协议路径使用 `/events/stream`。两个入口复用
// 完全相同的权限、Last-Event-ID 和 CORS 实现，不维护两套 SSE 行为。
export { GET, OPTIONS } from "../route";
