"""生成具有业务因果关系的隔离数据，验证训练闭环而不冒充真实用户反馈。"""

from __future__ import annotations

import json
import math
import random
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from . import DATASET_SCHEMA_VERSION


# 仿真器使用正式分类 UUID，而不是仅在 Python 内部有意义的英文标签。这样种子模型
# 部署到影子环境后，真实请求的分类 Embedding 和 Wide 交叉能够复用训练参数；Agent ID
# 仍会按设计走 UNK，避免虚拟 Agent 身份冒充平台存量 Agent。
CATEGORY_IDS = {
    "product-and-development": "40000000-0000-4000-8000-000000000001",
    "research-analysis": "40000000-0000-4000-8000-000000000002",
    "content-and-design": "40000000-0000-4000-8000-000000000003",
    "data-processing": "40000000-0000-4000-8000-000000000004",
    "document-content": "40000000-0000-4000-8000-000000000011",
    "image-design": "40000000-0000-4000-8000-000000000012",
    "video-production": "40000000-0000-4000-8000-000000000013",
    "product-requirements": "40000000-0000-4000-8000-000000000021",
    "interface-design": "40000000-0000-4000-8000-000000000022",
    "software-development": "40000000-0000-4000-8000-000000000023",
}
SPECIALTIES = tuple(CATEGORY_IDS)


@dataclass(frozen=True)
class SimulatedAgent:
    """控制漏斗概率的稳定虚拟画像，不会写入平台 Agent 目录。"""

    id: str
    # specialty 决定任务语义和标签拟合度；category 使用平台正式 UUID 进入模型特征。
    specialty: str
    category: str
    quality: float
    price: float
    response: float
    acceptance: float
    reliability: float
    onboard_day: int


def generate(output: Path, *, tasks: int = 10_000, agents: int = 100, seed: int = 20260914) -> dict[str, int]:
    """按曝光到履约的因果顺序生成可复现冷启动数据。

    每个任务先模拟合格召回与展示，再采样一次用户选择，最后只对被选择者采样接单和
    成功。该数据用于验证训练工程与 UNK 路径，始终写为 ``synthetic``，不能替代真实
    用户指标或触发 active 发布。
    """
    if tasks < 100 or agents < len(SPECIALTIES):
        raise ValueError("SIMULATION_SCALE_TOO_SMALL")
    randomizer = random.Random(seed)
    # 前 75% 从窗口开始即存在，后 25% 延迟入驻，构造按时间切分后真正未见的 Agent。
    newcomer_start = max(len(SPECIALTIES), math.ceil(agents * 0.75))
    profiles = [build_agent(randomizer, index, newcomer_start=newcomer_start) for index in range(agents)]
    started_at = datetime(2026, 1, 1, tzinfo=UTC)
    output.parent.mkdir(parents=True, exist_ok=True)
    rows = 0
    with output.open("w", encoding="utf-8") as stream:
        for task_index in range(tasks):
            day = int(task_index * 90 / tasks)
            specialty = randomizer.choice(SPECIALTIES)
            category = CATEGORY_IDS[specialty]
            complexity = randomizer.random()
            deadline_pressure = randomizer.random()
            budget = randomizer.uniform(0.7, 1.5)
            # 未到入驻日的 Agent 不可被召回，防止特征中出现“未来已知”的数据泄漏。
            available = [agent for agent in profiles if agent.onboard_day <= day]
            scored = []
            for agent in available:
                same_specialty = float(agent.specialty == specialty)
                semantic = clamp(randomizer.gauss(0.82 if same_specialty else 0.38, 0.10))
                tag_coverage = clamp(randomizer.gauss(0.90 if same_specialty else 0.35, 0.13))
                rule_score = 1.8 * semantic + tag_coverage + agent.quality - 0.25 * agent.price
                scored.append((rule_score, agent, semantic, tag_coverage))
            # V1/规则历史位置偏差保留少量噪声，避免仿真标签成为排序公式的机械复制。
            ranked = sorted(scored, key=lambda item: item[0] + randomizer.gauss(0, 0.12), reverse=True)
            displayed = ranked[:3]
            newcomers = [item for item in ranked if 0 <= day - item[1].onboard_day < 14]
            if newcomers and all(day - item[1].onboard_day >= 14 for item in displayed):
                # 仿真最低曝光保障让后期新 Agent 真正进入验证集；否则只有 UNK 参数，
                # 却没有未见 ID 的排序样本，冷启动指标会被错误报告为 0。
                displayed[-1] = newcomers[0]
            utilities = []
            for position, (_, agent, semantic, coverage) in enumerate(displayed, start=1):
                price_ratio = agent.price / budget
                utility = (
                    1.7 * semantic + 1.0 * coverage + 0.8 * agent.quality
                    - 0.9 * max(0.0, price_ratio - 1.0) - 0.23 * (position - 1)
                    + randomizer.gauss(0, 0.28)
                )
                utilities.append(utility)
            # outside choice 表示用户看过候选但没有选择任何人，为 CTR 提供必要负任务。
            selected_index = sample_choice_with_outside(randomizer, utilities, outside_weight=0.45)
            occurred_at = started_at + timedelta(days=day, seconds=task_index % 86_400)
            for position, ((_, agent, semantic, coverage), utility) in enumerate(zip(displayed, utilities), start=1):
                selected = selected_index == position - 1
                load = randomizer.randrange(0, 5)
                # 接单概率只对被选候选生效；负载和紧迫度提高会降低真实可接单能力。
                accepted_probability = logistic(1.6 * agent.acceptance - 0.35 * load - 0.5 * deadline_pressure)
                accepted = selected and randomizer.random() < accepted_probability
                # 履约成功继续以 accepted 为前置门，保持 success=>accepted=>selected。
                success_probability = logistic(
                    2.1 * agent.reliability + 1.2 * agent.quality + 0.7 * semantic
                    - 1.2 * complexity - 0.55 * deadline_pressure - 0.25 * load - 1.4
                )
                success = accepted and randomizer.random() < success_probability
                is_new = day - agent.onboard_day < 14
                record = {
                    "schemaVersion": DATASET_SCHEMA_VERSION,
                    "dataOrigin": "synthetic",
                    "taskId": str(uuid.uuid5(uuid.NAMESPACE_URL, f"matching-task:{task_index}")),
                    "agentId": agent.id,
                    "taskCategory": category,
                    "agentCategory": agent.category,
                    "occurredAt": occurred_at.isoformat().replace("+00:00", "Z"),
                    "semanticSimilarity": round(semantic, 6),
                    "tagCoverage": round(coverage, 6),
                    "priceRatio": round(agent.price / budget, 6),
                    "qualityScore": round(1 + 4 * agent.quality, 6),
                    "confidence": round(clamp((day - agent.onboard_day) / 60), 6),
                    "responseMinutes": round(agent.response, 6),
                    "currentLoad": load,
                    "onTimeRate": round(agent.reliability, 6),
                    "reworkRate": round(clamp(0.35 - 0.28 * agent.quality), 6),
                    "disputeRate": round(clamp(0.20 - 0.16 * agent.reliability), 6),
                    "admissionScore": round(60 + 38 * agent.quality, 6),
                    "position": position,
                    "isNew": int(is_new),
                    "selected": selected,
                    "accepted": accepted,
                    "success": success,
                    # utility 仅供仿真诊断，训练 schema 会忽略它，防止答案泄漏进模型。
                    "simulationUtility": round(utility, 6),
                }
                stream.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
                rows += 1
    return {"tasks": tasks, "agents": agents, "examples": rows}


def build_agent(randomizer: random.Random, index: int, *, newcomer_start: int) -> SimulatedAgent:
    """生成跨分类、价格和质量分布不同的虚拟 Agent，并固定可复现 UUID。"""
    specialty = SPECIALTIES[index % len(SPECIALTIES)]
    category = CATEGORY_IDS[specialty]
    # 后 25% Agent 在训练窗口结束后加入，确保验证/测试集真的包含训练词表未见 ID。
    # 阈值按本次 agents 参数计算，不能写死为 75；否则小规模冒烟会悄悄失去冷启动样本。
    onboard_day = 0 if index < newcomer_start else randomizer.randint(68, 80)
    quality = clamp(randomizer.betavariate(5, 2))
    return SimulatedAgent(
        id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"matching-agent:{index}")),
        specialty=specialty,
        category=category,
        quality=quality,
        price=randomizer.uniform(0.65, 1.65),
        response=randomizer.uniform(2, 40),
        acceptance=clamp(randomizer.betavariate(7, 2)),
        reliability=clamp(0.35 + 0.6 * quality + randomizer.gauss(0, 0.08)),
        onboard_day=onboard_day,
    )


def sample_choice_with_outside(randomizer: random.Random, utilities: list[float], outside_weight: float) -> int | None:
    """按 softmax 权重选择一个候选，也允许返回“不选择”的外部选项。"""
    weights = [math.exp(min(8.0, value)) for value in utilities]
    draw = randomizer.random() * (sum(weights) + outside_weight)
    for index, weight in enumerate(weights):
        draw -= weight
        if draw <= 0:
            return index
    return None


def logistic(value: float) -> float:
    """把线性效用映射到合法概率区间。"""
    return 1.0 / (1.0 + math.exp(-value))


def clamp(value: float) -> float:
    """裁剪受噪声影响的比率，防止仿真生成非法概率特征。"""
    return max(0.0, min(1.0, value))
