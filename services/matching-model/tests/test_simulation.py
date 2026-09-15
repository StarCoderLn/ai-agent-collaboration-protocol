import json

from aicp_matching_v2.schema import parse_example
from aicp_matching_v2.simulate import CATEGORY_IDS, generate


def test_simulation_is_reproducible_and_preserves_funnel(tmp_path):
    """同一随机种子必须逐字节复现，并始终满足成功=>接单=>选中。"""
    first = tmp_path / "first.jsonl"
    second = tmp_path / "second.jsonl"
    assert generate(first, tasks=120, agents=20, seed=7) == generate(second, tasks=120, agents=20, seed=7)
    assert first.read_bytes() == second.read_bytes()
    examples = [parse_example(json.loads(line)) for line in first.read_text().splitlines()]
    assert examples
    assert all(example.success <= example.accepted <= example.selected for example in examples)
    assert any(example.success for example in examples)
    assert any(not example.selected for example in examples)
    assert {example.task_category for example in examples} <= set(CATEGORY_IDS.values())
    assert {example.agent_category for example in examples} <= set(CATEGORY_IDS.values())


def test_small_simulation_contains_agents_unseen_in_training_window(tmp_path):
    """验证时间切分后的冷启动集合真实存在，防止空集合让指标产生误导。"""
    output = tmp_path / "small.jsonl"
    generate(output, tasks=1_000, agents=60, seed=20260914)
    rows = [json.loads(line) for line in output.read_text().splitlines()]
    split = int(len(rows) * 0.70)
    training_agent_ids = {row["agentId"] for row in rows[:split]}
    later_agent_ids = {row["agentId"] for row in rows[split:]}

    # 小规模验证也必须覆盖真正未见过的 Agent ID，否则 cold-start 指标为 0 只能说明
    # 没有测试数据，不能证明 UNK 路径可用。
    assert later_agent_ids - training_agent_ids
