"""训练样本的唯一权威字段定义与边界校验。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any

from . import DATASET_SCHEMA_VERSION


# 顺序就是张量列顺序，属于模型制品契约。新增、删除或调换字段必须升级特征版本并重训。
NUMERIC_FEATURES = (
    "semantic_similarity",
    "tag_coverage",
    "price_ratio",
    "quality_score",
    "confidence",
    "response_minutes",
    "current_load",
    "on_time_rate",
    "rework_rate",
    "dispute_rate",
    "admission_score",
    "position",
    "is_new",
)


@dataclass(frozen=True)
class Example:
    """通过边界校验后的单次候选曝光。

    ``selected``、``accepted``、``success`` 使用浮点是为了直接构造 BCE 标签张量；它们
    在解析时仍只接受 JSON boolean，防止任意概率值伪装成观测事实。
    """
    task_id: str
    agent_id: str
    task_category: str
    agent_category: str
    occurred_at: datetime
    data_origin: str
    numeric: tuple[float, ...]
    selected: float
    accepted: float
    success: float


def parse_example(raw: dict[str, Any], *, require_labels: bool = True) -> Example:
    """把不可信 JSON 收敛为可信样本，并校验漏斗单调关系。

    在线评分没有结果标签，因此 ``require_labels=False`` 时缺失标签被填成零，但这些值
    只用于复用张量构造函数，不参与推理输出。训练入口始终要求三个标签存在。
    """
    if raw.get("schemaVersion") != DATASET_SCHEMA_VERSION:
        raise ValueError("MATCHING_DATASET_SCHEMA_UNSUPPORTED")
    origin = required_text(raw, "dataOrigin")
    if origin not in {"real", "synthetic"}:
        raise ValueError("MATCHING_DATA_ORIGIN_INVALID")
    occurred_at = datetime.fromisoformat(required_text(raw, "occurredAt").replace("Z", "+00:00"))
    numeric = tuple(finite_number(raw, snake_to_camel(name)) for name in NUMERIC_FEATURES)
    selected = binary_label(raw, "selected", require_labels)
    accepted = binary_label(raw, "accepted", require_labels)
    success = binary_label(raw, "success", require_labels)
    # 成功必然先接单，接单必然先被选中；违反该顺序说明采集或数据拼接发生了错误。
    if success > accepted or accepted > selected:
        raise ValueError("MATCHING_FUNNEL_LABEL_INVALID")
    return Example(
        task_id=required_text(raw, "taskId"),
        agent_id=required_text(raw, "agentId"),
        task_category=required_text(raw, "taskCategory"),
        agent_category=required_text(raw, "agentCategory"),
        occurred_at=occurred_at,
        data_origin=origin,
        numeric=numeric,
        selected=selected,
        accepted=accepted,
        success=success,
    )


def required_text(raw: dict[str, Any], key: str) -> str:
    """读取非空文本并在唯一边界去除首尾空白。"""
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"MATCHING_FIELD_INVALID:{key}")
    return value.strip()


def finite_number(raw: dict[str, Any], key: str) -> float:
    """拒绝 bool、NaN 与无穷值，避免归一化后污染整批梯度。"""
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"MATCHING_FIELD_INVALID:{key}")
    number = float(value)
    if number != number or number in {float("inf"), float("-inf")}:
        raise ValueError(f"MATCHING_FIELD_INVALID:{key}")
    return number


def binary_label(raw: dict[str, Any], key: str, required: bool) -> float:
    """将观测布尔标签转换为 BCE 所需浮点；在线无标签请求使用零占位。"""
    if not required and key not in raw:
        return 0.0
    value = raw.get(key)
    if not isinstance(value, bool):
        raise ValueError(f"MATCHING_LABEL_INVALID:{key}")
    return float(value)


def snake_to_camel(value: str) -> str:
    """把内部稳定列名转换为 JSON 契约使用的 camelCase。"""
    head, *tail = value.split("_")
    return head + "".join(item.title() for item in tail)
