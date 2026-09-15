"""在固定时间测试集上比较 V1 原始顺序与 V2 影子排序。"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from pathlib import Path

from .schema import Example
from .serving import Predictor
from .training import load_examples, log_loss, ndcg


def compare(input_path: Path, artifact_path: Path, artifact_sha256: str) -> dict[str, object]:
    """返回可复现的离线对照结果，并拒绝模型与数据集错配。

    V1 基线使用样本中冻结的展示位置，V2 使用 ``pCTCVR`` 重新排序。两者面对完全相同
    的候选集合，因此 Top-1 和 NDCG 差异只来自排序，不会混入召回数量变化。
    """
    dataset_sha256 = hashlib.sha256(input_path.read_bytes()).hexdigest()
    predictor = Predictor(artifact_path, artifact_sha256)
    if predictor.metadata.get("datasetSha256") != dataset_sha256:
        raise ValueError("MATCHING_COMPARISON_DATASET_MISMATCH")

    examples = sorted(load_examples(input_path), key=lambda item: item.occurred_at)
    validation_end = int(len(examples) * 0.85)
    testing = examples[validation_end:]
    if not testing:
        raise ValueError("MATCHING_COMPARISON_TEST_SET_EMPTY")

    pctr_values, _, pctcvr_values = predictor.predict_probabilities(testing)

    # position 是训练 Schema 中的第十二个连续字段。负号让数值较大的“第一名”在通用
    # 降序指标函数中仍排在前面，而无需复制一套只服务 V1 的 NDCG 实现。
    v1_scores = [-item.numeric[11] for item in testing]
    training = examples[: int(len(examples) * 0.70)]
    train_agent_ids = {item.agent_id for item in training}
    cold_task_ids = {item.task_id for item in testing if item.agent_id not in train_agent_ids}
    ctr_prior = sum(item.selected for item in training) / len(training)
    success_prior = sum(item.success for item in training) / len(training)

    v1_top1_selected = top1_rate(testing, v1_scores, "selected")
    v2_top1_selected = top1_rate(testing, pctcvr_values, "selected")
    v1_top1_success = top1_rate(testing, v1_scores, "success")
    v2_top1_success = top1_rate(testing, pctcvr_values, "success")
    return {
        "modelVersion": predictor.metadata["version"],
        "datasetSha256": dataset_sha256,
        "testExamples": len(testing),
        "testTasks": len({item.task_id for item in testing}),
        "coldStartTasks": len(cold_task_ids),
        "v1": {
            "ndcgAt3": ndcg(testing, v1_scores),
            "top1SelectedRate": v1_top1_selected,
            "top1SuccessRate": v1_top1_success,
        },
        "v2": {
            "ndcgAt3": ndcg(testing, pctcvr_values),
            "top1SelectedRate": v2_top1_selected,
            "top1SuccessRate": v2_top1_success,
            "ctrLogLoss": log_loss([item.selected for item in testing], pctr_values),
            "ctcvrLogLoss": log_loss([item.success for item in testing], pctcvr_values),
        },
        "constantBaseline": {
            "ctrLogLoss": log_loss([item.selected for item in testing], [ctr_prior] * len(testing)),
            "ctcvrLogLoss": log_loss([item.success for item in testing], [success_prior] * len(testing)),
        },
        "delta": {
            # 乘以 100 后单位是百分点，例如 0.0193 表示提高约 1.93 个百分点。
            "top1SelectedPercentagePoints": (v2_top1_selected - v1_top1_selected) * 100,
            "top1SuccessPercentagePoints": (v2_top1_success - v1_top1_success) * 100,
        },
    }


def top1_rate(examples: list[Example], predictions: list[float], label: str) -> float:
    """按任务选出预测第一名，再计算该候选指定观测标签的平均值。"""
    groups: dict[str, list[tuple[float, str, int]]] = defaultdict(list)
    for index, (item, prediction) in enumerate(zip(examples, predictions)):
        # Agent ID 是同分时的稳定决胜键，保证不同进程重复评估得到相同结果。
        groups[item.task_id].append((prediction, item.agent_id, index))
    winners = [max(group, key=lambda item: (item[0], item[1]))[2] for group in groups.values()]
    return sum(float(getattr(examples[index], label)) for index in winners) / len(winners)
