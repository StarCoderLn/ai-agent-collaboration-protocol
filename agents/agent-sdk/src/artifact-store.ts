import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const MIME_BY_EXTENSION = new Map([
	[".svg", "image/svg+xml"],
	[".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	[".html", "text/html; charset=utf-8"],
]);

export type StoredArtifact = Readonly<{
	url: string;
	sizeBytes: string;
}>;

/**
 * 示例 Agent 的产物目录位于 .local，重启后仍可访问，但不会进入 Git。随机文件名既避免
 * 覆盖历史任务，也让公开下载地址无法被顺序枚举；生产环境可在同一接口后替换对象存储。
 */
export class FileArtifactStore {
	constructor(
		private readonly directory: string,
		private readonly publicBaseUrl: string,
	) {}

	async write(extension: "svg" | "pptx" | "html", content: string | Uint8Array): Promise<StoredArtifact> {
		await mkdir(this.directory, { recursive: true });
		const fileName = `${randomUUID()}.${extension}`;
		const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
		await writeFile(join(this.directory, fileName), bytes, { flag: "wx" });
		return {
			url: `${this.publicBaseUrl}/artifacts/${fileName}`,
			sizeBytes: String(bytes.byteLength),
		};
	}

	async read(fileName: string): Promise<Readonly<{ content: Buffer; mimeType: string }> | null> {
		// 文件名只允许运行时自己生成的 UUID 与白名单扩展名，拒绝 ../ 和编码绕过。
		if (!/^[0-9a-f-]{36}\.(?:svg|pptx|html)$/.test(fileName)) return null;
		const mimeType = MIME_BY_EXTENSION.get(extname(fileName));
		if (mimeType === undefined) return null;
		try {
			return { content: await readFile(join(this.directory, fileName)), mimeType };
		} catch (error) {
			if (isMissingFile(error)) return null;
			throw error;
		}
	}
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
