/**
 * 根据 `src/routes` 下各级 `route.ts` 生成静态 Hono 路由表。
 *
 * 路由模块继续导出标准 Web `Request → Response` 函数，生成器只负责把目录中的 `[id]`
 * 参数转换为 Hono 的 `:id`。显式静态 import 让 esbuild 能完整打包 Lambda，同时避免在
 * 冷启动阶段扫描只读文件系统。生成文件属于构建制品索引，不承载业务规则。
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../src/routes",
);
const output = path.resolve(root, "registry.generated.ts");

async function collect(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries.sort((left, right) =>
		left.name.localeCompare(right.name),
	)) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await collect(absolute)));
		else if (entry.name === "route.ts") files.push(absolute);
	}
	return files;
}

const files = await collect(root);
const definitions = [];
for (const [index, file] of files.entries()) {
	const source = await readFile(file, "utf8");
	const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].filter(
		(method) =>
			new RegExp(
				`export\\s+(?:(?:async\\s+)?function\\s+${method}\\b|const\\s+${method}\\s*=)`,
			).test(source),
	);
	if (methods.length === 0) throw new Error(`路由没有导出 HTTP 方法：${file}`);
	const relative = path.relative(root, path.dirname(file)).split(path.sep);
	const routePath = `/api/${relative.map((segment) => segment.replace(/^\[([^\]]+)\]$/, ":$1")).join("/")}`;
	const importPath = `./${path.relative(root, file).replaceAll(path.sep, "/").replace(/\.ts$/, "")}`;
	definitions.push({ index, importPath, routePath, methods });
}

const imports = definitions
	.map((item) => `import * as route${item.index} from "${item.importPath}";`)
	.join("\n");
const rows = definitions
	.map(
		(item) => `\t{
\t\tpath: ${JSON.stringify(item.routePath)},
\t\tmethods: [${item.methods.map((method) => JSON.stringify(method)).join(", ")}],
\t\tmodule: route${item.index},
\t},`,
	)
	.join("\n");
const generated = `/* 此文件由 scripts/generate-route-registry.mjs 生成，请勿手工编辑。 */\nimport type { RouteDefinition } from "../hono-route-adapter";\n${imports}\n\nexport const routeDefinitions: readonly RouteDefinition[] = [\n${rows}\n];\n`;
await writeFile(output, generated, "utf8");
