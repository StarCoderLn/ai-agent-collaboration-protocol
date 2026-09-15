import { timingSafeEqual } from "node:crypto";

/** 内部服务 token 使用常量时间比较，避免各 Route Handler 复制出不同的认证边界。 */
export function validInternalBearer(
	header: string | null,
	expected: string,
): boolean {
	if (expected.length === 0 || header === null || !header.startsWith("Bearer "))
		return false;
	const provided = Buffer.from(header.slice("Bearer ".length));
	const wanted = Buffer.from(expected);
	return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
