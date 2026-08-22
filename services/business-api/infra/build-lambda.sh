#!/bin/bash
# 把 Next.js `output: "standalone"` 的构建产物打包成 CDK 能直接 `Code.fromAsset()`
# 的目录（不用 Docker，见 specs/2.agent-registration/tasks.md T-009 的部署方案决策）。
#
# 步骤与 AWS 官方 Next.js zip 示例的 Makefile 等价（改写成不依赖 SAM CLI 的独立脚本）：
# https://github.com/aws/aws-lambda-web-adapter/blob/main/examples/nextjs-zip/app/Makefile
#
# 用法：在 services/business-api 目录下执行 `bash infra/build-lambda.sh`
# （由 package.json 的 infra:build-lambda script 调用，不直接手动运行）。
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

OUT_DIR="infra/.dist/lambda"

echo "==> next build（output: standalone）"
pnpm build

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "==> 复制 standalone 运行时（-L 解析符号链接为真实文件）"
# pnpm 的 node_modules 是指向 node_modules/.pnpm/<pkg>/... 虚拟存储的符号链接；
# `.next/standalone/node_modules` 里这些链接是相对路径，一旦把 standalone 目录整体
# 复制到别处（比如这里的 $OUT_DIR），相对路径的目标就不再存在，产生"悬空链接"，
# 运行时报 Cannot find module（已实测复现 @swc/helpers、@next/env 两例）。用 `-L`
# 让 cp 复制符号链接指向的真实内容而不是链接本身，从根源解决，不是一个个补依赖。
# 已知社区问题：https://github.com/vercel/next.js/issues/48017
cp -rL .next/standalone/. "$OUT_DIR/"

# 上面的 -L 把 `node_modules/next` 从 `.pnpm/next@<ver>/node_modules/next` 拍平到了
# 顶层 `node_modules/next`，导致它跟同一个 .pnpm 条目里的兄弟包（如 @next/env、
# styled-jsx）失去目录相邻关系——Node 沿目录链向上找 node_modules 时不会再经过
# `.pnpm/next@<ver>/node_modules/`，只会直接查顶层 `node_modules/@next/env`，查不到
# 就报 Cannot find module（已实测复现）。这些包其实都在 pnpm 的别名暂存目录
# `node_modules/.pnpm/node_modules/` 里（pnpm 自己为"应该在顶层可见"的包维护的一份
# 索引），逐个补到顶层即可，不是一个个加 package.json 依赖去堵。
echo "==> 补齐 pnpm 顶层依赖别名（next standalone 追踪未保留的兄弟包）"
ALIAS_DIR="$OUT_DIR/node_modules/.pnpm/node_modules"
if [ -d "$ALIAS_DIR" ]; then
  for entry in "$ALIAS_DIR"/*; do
    name="$(basename "$entry")"
    if [[ "$name" == @* ]]; then
      mkdir -p "$OUT_DIR/node_modules/$name"
      for subentry in "$entry"/*; do
        subname="$(basename "$subentry")"
        [ -e "$OUT_DIR/node_modules/$name/$subname" ] || cp -RL "$subentry" "$OUT_DIR/node_modules/$name/$subname"
      done
    else
      [ -e "$OUT_DIR/node_modules/$name" ] || cp -RL "$entry" "$OUT_DIR/node_modules/$name"
    fi
  done
fi

echo "==> 复制静态资源（standalone 输出默认不含 .next/static，需手动补齐）"
mkdir -p "$OUT_DIR/.next/static"
cp -r .next/static/. "$OUT_DIR/.next/static/"

if [ -d "public" ]; then
  echo "==> 复制 public/（当前无此目录，此分支预留给后续新增静态资源）"
  mkdir -p "$OUT_DIR/public"
  cp -r public/. "$OUT_DIR/public/"
fi

echo "==> 复制 Lambda 启动脚本（作为 Handler）"
cp infra/run.sh "$OUT_DIR/run.sh"
chmod +x "$OUT_DIR/run.sh"

# Lambda 部署包本身只读，Next.js server.js 默认会往相对路径 .next/cache 写增量缓存；
# 把它软链到 /tmp/cache（run.sh 已确保该目录存在），避免请求处理时因写入只读文件系统报错。
rm -rf "$OUT_DIR/.next/cache"
ln -s /tmp/cache "$OUT_DIR/.next/cache"

echo "==> 构建产物已就绪：$OUT_DIR"
