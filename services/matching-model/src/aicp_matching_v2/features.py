"""训练与 ONNX 推理共享的确定性特征编码。"""

from __future__ import annotations

import random
from collections.abc import Sequence

import numpy as np

from .model import wide_crosses
from .schema import Example, NUMERIC_FEATURES


def encode_features(
    examples: Sequence[Example],
    agent_vocab: dict[str, int],
    category_vocab: dict[str, int],
    means: list[float],
    scales: list[float],
    *,
    mask_unknown: bool,
) -> dict[str, np.ndarray]:
    """把可信样本编码成训练与推理共用的命名数组。

    Wide 特征固定为每个候选四个哈希交叉，因此使用二维矩阵表达。训练侧再把矩阵展开为
    EmbeddingBag 输入，ONNX 则直接对第二维求和；两条路径共享同一原始数组，避免训练与
    线上服务各自复制词表、归一化或哈希逻辑。
    """
    agent_ids: list[int] = []
    task_categories: list[int] = []
    agent_categories: list[int] = []
    numeric: list[list[float]] = []
    wide_indices: list[tuple[int, ...]] = []
    for item in examples:
        agent_id = agent_vocab.get(item.agent_id, 0)
        if mask_unknown and random.random() < 0.20:
            agent_id = 0
        agent_ids.append(agent_id)
        task_categories.append(category_vocab.get(item.task_category, 0))
        agent_categories.append(category_vocab.get(item.agent_category, 0))
        numeric.append([(value - mean) / scale for value, mean, scale in zip(item.numeric, means, scales)])
        wide_indices.append(
            wide_crosses(item.task_category, item.agent_category, item.numeric[2], int(item.numeric[11]), 2048),
        )
    if not examples:
        raise ValueError("MATCHING_FEATURE_BATCH_EMPTY")
    return {
        "agent_ids": np.asarray(agent_ids, dtype=np.int64),
        "task_categories": np.asarray(task_categories, dtype=np.int64),
        "agent_categories": np.asarray(agent_categories, dtype=np.int64),
        "numeric": np.asarray(numeric, dtype=np.float32).reshape(len(examples), len(NUMERIC_FEATURES)),
		"wide_indices": np.asarray(wide_indices, dtype=np.int64).reshape(len(examples), 4),
	}
