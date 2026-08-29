// @vitest-environment node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CodeArtifactSchema, DesignArtifactSchema } from "@/lib/workflow/contracts";
import { compileCodePreview } from "./code-preview";

const runRealPreview = process.env.REAL_MODEL_SMOKE_INPUT === undefined ? it.skip : it;

describe("真实模型制品预览", () => {
	runRealPreview("使用生产隔离编译器运行 Design 与 Coding 两份页面", async () => {
		const inputPath = process.env.REAL_MODEL_SMOKE_INPUT;
		if (inputPath === undefined) {
			throw new Error("真实预览测试必须指定 REAL_MODEL_SMOKE_INPUT");
		}
		const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
		const artifacts = z.object({
			design: DesignArtifactSchema,
			code: CodeArtifactSchema,
		}).strict().parse(raw);

		const [designPreview, codePreview] = await Promise.all([
			compileCodePreview({ artifact: artifacts.design }),
			compileCodePreview({ artifact: artifacts.code }),
		]);
		expect(designPreview.verification).toMatchObject({ status: "passed", fileCount: 2 });
		expect(codePreview.verification.status).toBe("passed");
		expect(codePreview.html).toContain(artifacts.design.prototype.globalsCss);

		const outputDirectory = process.env.REAL_MODEL_SMOKE_PREVIEW_DIR;
		if (outputDirectory !== undefined && outputDirectory.length > 0) {
			// 仅在显式指定临时目录时保存可直接打开的 HTML，普通测试不会污染工作区。
			await mkdir(outputDirectory, { recursive: true });
			await Promise.all([
				writeFile(join(outputDirectory, "design.html"), designPreview.html, "utf8"),
				writeFile(join(outputDirectory, "code.html"), codePreview.html, "utf8"),
			]);
		}
	}, 30_000);
});
