import { NextResponse } from "next/server";

export function GET(request: Request): Response {
	const id = new URL(request.url).searchParams.get("id")?.trim() ?? "";
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
		return NextResponse.redirect(new URL("/admin/disputes", request.url), 303);
	}
	return NextResponse.redirect(new URL(`/admin/disputes/${encodeURIComponent(id.toLowerCase())}`, request.url), 303);
}
