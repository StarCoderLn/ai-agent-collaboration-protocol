import {
	CodePreviewError,
	compileCodePreview,
	previewRequestIsTooLarge,
} from "@/lib/deliverables/code-preview";

export async function POST(request: Request): Promise<Response> {
	if (previewRequestIsTooLarge(request)) {
		return Response.json(
			{
				code: "PREVIEW_REQUEST_INVALID",
				message: "代码制品超过预览大小限制",
			},
			{ status: 413 },
		);
	}
	try {
		const raw: unknown = await request.json();
		const result = await compileCodePreview(raw);
		return Response.json(result, {
			headers: { "cache-control": "private, no-store" },
		});
	} catch (error) {
		if (error instanceof CodePreviewError) {
			return Response.json(
				{ code: error.code, message: error.message },
				{ status: error.code === "PREVIEW_REQUEST_INVALID" ? 422 : 409 },
			);
		}
		return Response.json(
			{
				code: "PREVIEW_COMPILE_FAILED",
				message: "网站预览暂时无法生成",
			},
			{ status: 500 },
		);
	}
}
