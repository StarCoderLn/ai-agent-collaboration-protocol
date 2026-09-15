#!/usr/bin/env bash
set -euo pipefail

# Hono 的 Lambda 入口直接导出 `handler`，无需启动 HTTP server，也不再复制 Next.js
# standalone、React 静态资源或 Lambda Web Adapter 启动脚本。esbuild 会把应用依赖打进
# 单个 CommonJS 文件，CDK 只上传这个确定的目录。业务源码继续使用 ESM；这里只在最终
# Lambda 制品边界转为 CommonJS，因为 SIWE 的 apg-js 依赖会动态 require Node `buffer`，
# 打成 ESM 时 esbuild 的兼容桩会在冷启动阶段主动抛错。
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$SCRIPT_DIR/.dist/lambda"

cd "$APP_DIR"
pnpm generate:routes
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"
pnpm exec esbuild src/lambda.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="$DIST_DIR/index.js"

test -s "$DIST_DIR/index.js"
echo "Hono Lambda 制品已生成：$DIST_DIR/index.js"
