// @vitest-environment node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
	CodeArtifactSchema,
	DesignArtifactSchema,
} from "@/lib/workflow/contracts";
import { compileCodePreview } from "./code-preview";

const runRealPreview =
	process.env.REAL_MODEL_SMOKE_INPUT === undefined ? it.skip : it;

describe("真实模型制品预览", () => {
	runRealPreview(
		"用静态图片验收 Design，并使用生产隔离编译器运行 Coding 页面",
		async () => {
			const inputPath = process.env.REAL_MODEL_SMOKE_INPUT;
			if (inputPath === undefined) {
				throw new Error("真实预览测试必须指定 REAL_MODEL_SMOKE_INPUT");
			}
			const raw: unknown = JSON.parse(await readFile(inputPath, "utf8"));
			const artifacts = z
				.object({
					design: DesignArtifactSchema,
					code: CodeArtifactSchema,
				})
				.strict()
				.parse(raw);

			const codePreview = await compileCodePreview({
				artifact: artifacts.code,
			});
			expect(
				artifacts.design.renderedScreens.map((screen) => screen.id),
			).toEqual(["desktop", "mobile"]);
			expect(codePreview.verification.status).toBe("passed");
			expect(codePreview.html).toContain(
				`--primary:${artifacts.design.tokens.primaryColor}`,
			);

			const outputDirectory = process.env.REAL_MODEL_SMOKE_PREVIEW_DIR;
			if (outputDirectory !== undefined && outputDirectory.length > 0) {
				// 仅在显式指定临时目录时保存可直接打开的 HTML，普通测试不会污染工作区。
				await mkdir(outputDirectory, { recursive: true });
				await writeFile(
					join(outputDirectory, "code.html"),
					codePreview.html,
					"utf8",
				);
			}
		},
		30_000,
	);
});
