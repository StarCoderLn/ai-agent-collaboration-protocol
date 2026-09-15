"""时间切分、UNK 增强、ESMM 训练与可复现模型制品。"""

from __future__ import annotations

import hashlib
import json
import math
import random
from collections import defaultdict
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import torch
from torch import nn

from . import FEATURE_SCHEMA_VERSION
from .artifact import assert_onnx_matches_pytorch, export_onnx
from .features import encode_features
from .model import WideDeepESMM
from .schema import NUMERIC_FEATURES, Example, parse_example


@dataclass(frozen=True)
class Metrics:
    """发布评估所需的概率校准与 Top-3 排序指标。"""

    ctr_log_loss: float
    ctcvr_log_loss: float
    ndcg_at_3: float
    cold_start_ndcg_at_3: float


def train(input_path: Path, artifact_dir: Path, *, epochs: int = 8, seed: int = 20260914) -> dict[str, object]:
    """训练一个可复现的 Wide & Deep ESMM 制品并返回注册摘要。

    数据严格按时间而非随机切分，避免未来行为泄漏到历史训练集。模型只直接监督 CTR 与
    CTCVR；条件 CVR 由两个概率头的关系得到，从而在完整曝光空间处理选择偏差。
    """
    torch.manual_seed(seed)
    random.seed(seed)
    examples = load_examples(input_path)
    if len(examples) < 300:
        raise ValueError("MATCHING_TRAINING_SAMPLE_TOO_SMALL")
    examples.sort(key=lambda item: item.occurred_at)
    # 70/15/15 时间切分同时用于普通指标和后期新 Agent 的冷启动指标。
    train_end = int(len(examples) * 0.70)
    validation_end = int(len(examples) * 0.85)
    training, validation, testing = examples[:train_end], examples[train_end:validation_end], examples[validation_end:]
    agent_vocab = vocabulary(item.agent_id for item in training)
    category_vocab = vocabulary([item.task_category for item in training] + [item.agent_category for item in training])
    means, scales = normalization(training)
    model = WideDeepESMM(
        agent_count=len(agent_vocab) + 1,
        category_count=len(category_vocab) + 1,
        numeric_count=len(NUMERIC_FEATURES),
    )
    # AdamW 的独立权重衰减限制小样本下的 Wide 记忆过拟合；BCE 与二元漏斗标签一致。
    optimizer = torch.optim.AdamW(model.parameters(), lr=0.003, weight_decay=1e-4)
    loss_function = nn.BCELoss()
    for _ in range(epochs):
        model.train()
        shuffled = list(training)
        random.shuffle(shuffled)
        for offset in range(0, len(shuffled), 256):
            batch = tensors(shuffled[offset:offset + 256], agent_vocab, category_vocab, means, scales, mask_unknown=True)
            pctr, _, pctcvr = model(*batch[:6])
            # ESMM 不在已选子集直接拟合 CVR；联合成功标签在所有曝光上都有定义。
            loss = loss_function(pctr, batch[6]) + loss_function(pctcvr, batch[7])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
    validation_metrics = evaluate(model, validation, agent_vocab, category_vocab, means, scales)
    test_metrics = evaluate(model, testing, agent_vocab, category_vocab, means, scales)
    # 数据集哈希同时进入版本号和元数据，使同一输入可审计，且制品能追溯到精确 JSONL。
    digest = hashlib.sha256(input_path.read_bytes()).hexdigest()
    version = f"matching-v2-{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}-{digest[:8]}"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    artifact_path = artifact_dir / f"{version}.onnx"
    metadata = {
        "version": version,
        "featureSchemaVersion": FEATURE_SCHEMA_VERSION,
        "datasetSha256": digest,
        "dataOrigin": single_origin(examples),
        "sampleCount": len(examples),
        "agentVocabulary": agent_vocab,
        "categoryVocabulary": category_vocab,
        "numericMeans": means,
        "numericScales": scales,
        "validationMetrics": asdict(validation_metrics),
        "testMetrics": asdict(test_metrics),
        "modelConfig": {
            "wideBuckets": model.wide_buckets,
            "wideFeatureCount": 4,
            "numericCount": len(NUMERIC_FEATURES),
            "artifactFormat": "onnx",
            "onnxOpset": 17,
        },
    }
    # 归一化统计和词表写入 ONNX metadata_props，与网络参数受同一个 SHA-256 保护。
    export_onnx(model, metadata, artifact_path)
    parity_examples = validation[: min(256, len(validation))]
    parity_inputs = encode_features(
        parity_examples, agent_vocab, category_vocab, means, scales, mask_unknown=False,
    )
    # 模型注册前必须证明 PyTorch 与 ONNX Runtime 在真实验证分片上数值一致。
    assert_onnx_matches_pytorch(model, artifact_path, parity_inputs)
    artifact_sha256 = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
    return {**metadata, "artifactPath": str(artifact_path.resolve()), "artifactSha256": artifact_sha256}


def load_examples(path: Path) -> list[Example]:
    """逐行加载 JSONL，并把错误定位到稳定行号而不回显敏感样本正文。"""
    result = []
    with path.open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                result.append(parse_example(json.loads(line)))
            except (ValueError, json.JSONDecodeError) as error:
                raise ValueError(f"MATCHING_DATASET_INVALID:{line_number}:{error}") from error
    return result


def vocabulary(values: Iterable[str]) -> dict[str, int]:
    """按稳定字典序分配离散下标；0 永远保留给 UNK/padding。"""
    # 真实词表从 1 开始，未见的新 Agent 自然落入同一路径。
    return {value: index for index, value in enumerate(sorted(set(values)), start=1)}


def normalization(examples: list[Example]) -> tuple[list[float], list[float]]:
    """只用训练分片计算均值和样本标准差，验证/测试不能参与统计。"""
    columns = list(zip(*(item.numeric for item in examples)))
    means = [sum(column) / len(column) for column in columns]
    scales = []
    for column, mean in zip(columns, means):
        variance = sum((value - mean) ** 2 for value in column) / max(1, len(column) - 1)
        # 常量列使用极小正尺度，避免除零；其归一化结果仍为 0，不会制造虚假信号。
        scales.append(max(1e-6, math.sqrt(variance)))
    return means, scales


def tensors(
    examples: list[Example], agent_vocab: dict[str, int], category_vocab: dict[str, int],
    means: list[float], scales: list[float], *, mask_unknown: bool,
) -> tuple[torch.Tensor, ...]:
    """把可信样本编码为模型输入和两个全曝光监督标签。

    ``mask_unknown`` 仅在训练批次开启，随机把 20% 已知 Agent 映射到 0，迫使网络学习
    分类和连续特征；验证、测试与在线推理只对词表外身份使用 UNK。
    """
    encoded = encode_features(
        examples, agent_vocab, category_vocab, means, scales, mask_unknown=mask_unknown,
    )
    wide_matrix = encoded["wide_indices"]
    # 训练模型沿用 EmbeddingBag 的扁平输入；线上 ONNX 对固定四列直接求和，两者在导出
    # 门禁中逐批比较，不能各自维护另一套 Wide 编码。
    wide_offsets = torch.arange(0, len(examples) * wide_matrix.shape[1], wide_matrix.shape[1], dtype=torch.long)
    return (
        torch.from_numpy(encoded["agent_ids"]),
        torch.from_numpy(encoded["task_categories"]),
        torch.from_numpy(encoded["agent_categories"]),
        torch.from_numpy(encoded["numeric"]),
        torch.from_numpy(wide_matrix.reshape(-1)),
        wide_offsets,
        torch.tensor([item.selected for item in examples], dtype=torch.float32),
        torch.tensor([item.success for item in examples], dtype=torch.float32),
    )


def evaluate(
    model: WideDeepESMM, examples: list[Example], agent_vocab: dict[str, int],
    category_vocab: dict[str, int], means: list[float], scales: list[float],
) -> Metrics:
    """在固定分片上计算概率损失、任务内排序和词表外 Agent 排序。"""
    model.eval()
    with torch.no_grad():
        batch = tensors(examples, agent_vocab, category_vocab, means, scales, mask_unknown=False)
        pctr, _, pctcvr = model(*batch[:6])
    pctr_values = pctr.tolist()
    pctcvr_values = pctcvr.tolist()
    # 冷启动评估以“包含至少一个未见 Agent 的完整任务候选集”为单位。若只留下未见
    # Agent 自身，许多任务会退化为单候选，NDCG 无需比较就接近 1，严重夸大冷启动能力。
    cold_task_ids = {item.task_id for item in examples if item.agent_id not in agent_vocab}
    cold = [index for index, item in enumerate(examples) if item.task_id in cold_task_ids]
    return Metrics(
        ctr_log_loss=log_loss([item.selected for item in examples], pctr_values),
        ctcvr_log_loss=log_loss([item.success for item in examples], pctcvr_values),
        ndcg_at_3=ndcg(examples, pctcvr_values),
        cold_start_ndcg_at_3=ndcg([examples[index] for index in cold], [pctcvr_values[index] for index in cold]) if cold else 0.0,
    )


def log_loss(labels: list[float], predictions: list[float]) -> float:
    """计算二元交叉熵；裁剪只防止 log(0)，不改变模型返回值。"""
    total = 0.0
    for label, prediction in zip(labels, predictions):
        probability = min(1 - 1e-7, max(1e-7, prediction))
        total -= label * math.log(probability) + (1 - label) * math.log(1 - probability)
    return total / max(1, len(labels))


def ndcg(examples: list[Example], predictions: list[float]) -> float:
    """按任务计算 Top-3 NDCG，并用漏斗深度赋予分级相关性。"""
    groups: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for item, prediction in zip(examples, predictions):
        # 成功比仅接单更有价值，接单又比仅选中更有价值；未交互候选相关性为 0。
        relevance = 3.0 if item.success else 2.0 if item.accepted else 1.0 if item.selected else 0.0
        groups[item.task_id].append((prediction, relevance))
    scores = []
    for group in groups.values():
        actual = dcg([relevance for _, relevance in sorted(group, reverse=True)[:3]])
        ideal = dcg(sorted((relevance for _, relevance in group), reverse=True)[:3])
        if ideal > 0:
            scores.append(actual / ideal)
    return sum(scores) / max(1, len(scores))


def dcg(relevances: list[float]) -> float:
    """使用指数增益和对数位置折损计算单个任务的 DCG。"""
    return sum((2**relevance - 1) / math.log2(index + 2) for index, relevance in enumerate(relevances))


def single_origin(examples: list[Example]) -> str:
    """汇总制品数据来源；混合来源必须显式标记，不能伪装成 real。"""
    origins = {item.data_origin for item in examples}
    return next(iter(origins)) if len(origins) == 1 else "mixed"
