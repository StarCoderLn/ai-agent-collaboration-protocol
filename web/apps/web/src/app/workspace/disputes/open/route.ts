import { NextResponse } from "next/server";

/** 卷宗入口只接受 UUID，避免把钱包或合约地址误当作争议 ID 带入动态路由。 */
export function GET(request: Request): Response {
	const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
		return NextResponse.redirect(new URL("/workspace/disputes", request.url), 303);
	}
	return NextResponse.redirect(new URL(`/workspace/disputes/${encodeURIComponent(id.toLowerCase())}`, request.url), 303);
}
