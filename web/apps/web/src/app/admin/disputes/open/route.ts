import { NextResponse } from "next/server";

/** 兼容旧书签；参数校验和目标路由统一由新的工作台入口负责。 */
export function GET(request: Request): Response {
	const target = new URL("/workspace/disputes/open", request.url);
	target.search = new URL(request.url).search;
	return NextResponse.redirect(target, 303);
}
