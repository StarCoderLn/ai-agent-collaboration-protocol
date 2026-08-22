#!/bin/bash
# Lambda 启动脚本，作为 AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap 的目标进程运行
# （AWS Lambda Web Adapter 用它把标准 HTTP server 接进 Lambda 调用模型）。
#
# 参考 AWS 官方 Next.js zip 示例：
# https://github.com/aws/aws-lambda-web-adapter/blob/main/examples/nextjs-zip/app/run.sh
#
# /tmp 是 Lambda 唯一可写目录；Next.js `output: "standalone"` 产出的 server.js
# 默认会尝试写入 `.next/cache`（部署包本身只读），infra/build-lambda.sh 已把
# `.next/cache` 软链到 /tmp/cache，这里只需确保该目录存在。
[ ! -d '/tmp/cache' ] && mkdir -p /tmp/cache

HOSTNAME=0.0.0.0 exec node server.js
