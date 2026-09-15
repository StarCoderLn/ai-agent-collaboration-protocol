from datetime import UTC, datetime

import pytest
import torch
from torch import nn

from aicp_matching_v2.comparison import compare
from aicp_matching_v2.schema import Example
from aicp_matching_v2.serving import Predictor
from aicp_matching_v2.simulate import generate
from aicp_matching_v2.training import evaluate, train


def test_wide_deep_esmm_trains_and_scores_unknown_agent(tmp_path):
    """覆盖从 synthetic JSONL 训练、制品哈希校验到未见 Agent 在线评分的最小闭环。"""
    dataset = tmp_path / "training.jsonl"
    generate(dataset, tasks=180, agents=20, seed=11)
    result = train(dataset, tmp_path / "artifacts", epochs=2, seed=11)
    assert result["dataOrigin"] == "synthetic"
    assert result["sampleCount"] == 540
    predictor = Predictor(result["artifactPath"], result["artifactSha256"])
    # 使用训练词表之外的 Agent ID，证明在线冷启动走 UNK，而非依赖仿真身份碰巧命中。
    candidate = {
        "schemaVersion": "matching-v2.dataset.v1",
        "dataOrigin": "real",
        "taskId": "task",
        "agentId": "brand-new-agent",
        "taskCategory": "research",
        "agentCategory": "research",
        "occurredAt": "2026-09-14T00:00:00Z",
        "semanticSimilarity": 0.9,
        "tagCoverage": 1.0,
        "priceRatio": 0.9,
        "qualityScore": 4.5,
        "confidence": 0.0,
        "responseMinutes": 5,
        "currentLoad": 0,
        "onTimeRate": 0.8,
        "reworkRate": 0.1,
        "disputeRate": 0.02,
        "admissionScore": 90,
        "position": 1,
        "isNew": 1,
    }
    score = predictor.score([candidate])[0]
    assert score["agentId"] == "brand-new-agent"
    assert 0 <= score["pctcvr"] <= score["pctr"] <= 1
    # 文件哈希属于反序列化前门禁，错误哈希必须在读取模型对象前被拒绝。
    with pytest.raises(ValueError, match="MATCHING_MODEL_ARTIFACT_HASH_MISMATCH"):
        Predictor(result["artifactPath"], "0" * 64)

    # 对照命令必须复用制品锁定的数据集，并给出同候选集上的 V1/V2 可比较指标。
    report = compare(dataset, result["artifactPath"], result["artifactSha256"])
    assert report["testExamples"] > 0
    assert report["v1"]["ndcgAt3"] >= 0
    assert report["v2"]["ctcvrLogLoss"] >= 0

    unrelated = tmp_path / "unrelated.jsonl"
    unrelated.write_text(dataset.read_text() + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="MATCHING_COMPARISON_DATASET_MISMATCH"):
        compare(unrelated, result["artifactPath"], result["artifactSha256"])


def test_cold_start_ndcg_keeps_the_complete_candidate_slate():
    """含新 Agent 的任务必须连同已知对手一起评估，不能退化为单候选满分。"""

    class FixedModel(nn.Module):
        """返回固定概率，使测试只锁定冷启动分组口径而不依赖训练随机性。"""

        def eval(self):
            return self

        def forward(self, *_inputs):
            pctr = torch.tensor([0.9, 0.1], dtype=torch.float32)
            pcvr = torch.tensor([0.5, 0.5], dtype=torch.float32)
            return pctr, pcvr, pctr * pcvr

    occurred_at = datetime(2026, 9, 14, tzinfo=UTC)
    numeric = (0.5,) * 13
    examples = [
        Example("task", "known", "category", "category", occurred_at, "synthetic", numeric, 0, 0, 0),
        Example("task", "new", "category", "category", occurred_at, "synthetic", numeric, 1, 1, 1),
    ]
    metrics = evaluate(
        FixedModel(),
        examples,
        {"known": 1},
        {"category": 1},
        [0.0] * 13,
        [1.0] * 13,
    )
    # 模型把已知失败候选排在新成功候选之前，完整 slate 的冷启动 NDCG 必须小于 1；
    # 旧实现只保留 new 一项，会在无需比较的情况下错误得到 1。
    assert metrics.cold_start_ndcg_at_3 < 1
