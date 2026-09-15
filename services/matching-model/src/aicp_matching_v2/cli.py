"""仿真、训练和影子服务的单一命令入口。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from .comparison import compare
from .serving import Predictor, serve
from .simulate import generate
from .training import train


def main() -> None:
    """解析四个互斥子命令，并把机器可读结果写到标准输出。

    Temporal Activity 依赖训练命令只输出一个 JSON 对象，因此这里不夹杂进度日志；模型
    服务则保持前台运行，由进程管理器负责生命周期和退出信号。
    """
    parser = argparse.ArgumentParser(prog="aicp-matching-v2")
    commands = parser.add_subparsers(dest="command", required=True)
    # simulate 只生成隔离的 synthetic JSONL，不访问业务数据库，也不会创建市场 Agent。
    simulate = commands.add_parser("simulate")
    simulate.add_argument("--output", type=Path, required=True)
    simulate.add_argument("--tasks", type=int, default=10_000)
    simulate.add_argument("--agents", type=int, default=100)
    simulate.add_argument("--seed", type=int, default=20260914)
    # train 同时写入模型参数和完整元数据；调用方用摘要注册版本与制品哈希。
    training = commands.add_parser("train")
    training.add_argument("--input", type=Path, required=True)
    training.add_argument("--artifact-dir", type=Path, required=True)
    training.add_argument("--epochs", type=int, default=8)
    training.add_argument("--seed", type=int, default=20260914)
    # compare 固定读取最后 15% 时间测试集，直接给出 V1 与指定 V2 制品的可复核对照。
    comparison = commands.add_parser("compare")
    comparison.add_argument("--input", type=Path, required=True)
    comparison.add_argument("--artifact", type=Path, required=True)
    comparison.add_argument("--sha256", required=True)
    # serve 在反序列化前校验 SHA-256，端口默认仅绑定 loopback，供影子 Worker 调用。
    server = commands.add_parser("serve")
    server.add_argument("--artifact", type=Path, required=True)
    server.add_argument("--sha256", required=True)
    server.add_argument("--address", default="127.0.0.1")
    server.add_argument("--port", type=int, default=3290)
    args = parser.parse_args()
    if args.command == "simulate":
        result = generate(args.output, tasks=args.tasks, agents=args.agents, seed=args.seed)
        print(json.dumps(result, ensure_ascii=False))
    elif args.command == "train":
        result = train(args.input, args.artifact_dir, epochs=args.epochs, seed=args.seed)
        # 完整词表已保存在模型制品中；命令行只输出注册所需摘要，避免数千个 Agent ID
        # 淹没 Temporal Activity 日志并扩大可观测性存储。
        summary = {
            key: value
            for key, value in result.items()
            if key not in {"agentVocabulary", "categoryVocabulary", "numericMeans", "numericScales"}
        }
        print(json.dumps(summary, ensure_ascii=False, separators=(",", ":")))
    elif args.command == "compare":
        report = compare(args.input, args.artifact, args.sha256)
        print(json.dumps(report, ensure_ascii=False, separators=(",", ":")))
    else:
        # argparse 已保证只可能进入 serve；保持一个出口避免三套启动逻辑产生配置差异。
        serve(Predictor(args.artifact, args.sha256), args.address, args.port)
