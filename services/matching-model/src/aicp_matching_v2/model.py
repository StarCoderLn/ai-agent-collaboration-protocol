"""Wide & Deep + ESMM 模型；选择和联合成功均在完整曝光空间监督。"""

from __future__ import annotations

import hashlib

import torch
from torch import nn


class WideDeepESMM(nn.Module):
    """共享 Deep 表示并保留任务独立 Wide 记忆项的两任务 ESMM。

    CTR 头学习“曝光后被选中”，CVR 头学习“选中后的成功倾向”。训练监督不直接使用
    条件 CVR 标签，而用两头乘积拟合全曝光空间中的成功标签，从而避免只观察已选中样本
    带来的样本选择偏差。
    """

    def __init__(self, *, agent_count: int, category_count: int, numeric_count: int, wide_buckets: int = 2048) -> None:
        """按制品词表尺寸构建网络；各尺寸必须与保存参数时完全一致。"""
        super().__init__()
        # 下标 0 同时是 padding/UNK。线上未见 Agent 与训练时随机遮蔽的 Agent 共用此表示，
        # 因而新 Agent 不需要临时扩充模型词表，也不会因为没有历史 ID Embedding 而报错。
        self.agent_embedding = nn.Embedding(agent_count, 12, padding_idx=0)
        self.task_category_embedding = nn.Embedding(category_count, 6, padding_idx=0)
        self.agent_category_embedding = nn.Embedding(category_count, 6, padding_idx=0)
        # Deep 分支吸收连续质量信号和低维离散表示，学习显式交叉之外的非线性关系。
        deep_input = 12 + 6 + 6 + numeric_count
        self.deep = nn.Sequential(
            nn.Linear(deep_input, 64), nn.ReLU(), nn.Dropout(0.10),
            nn.Linear(64, 32), nn.ReLU(),
        )
        # CTR/CVR 使用独立 Wide 参数：位置偏差可能影响点击/选择，却不应被强制解释为
        # 履约能力；共享的 Deep 干路仍让两个任务互相提供稀疏场景下的统计强度。
        self.wide_ctr = nn.EmbeddingBag(wide_buckets, 1, mode="sum")
        self.wide_cvr = nn.EmbeddingBag(wide_buckets, 1, mode="sum")
        self.ctr_head = nn.Linear(32, 1)
        self.cvr_head = nn.Linear(32, 1)
        self.wide_buckets = wide_buckets

    def forward(
        self,
        agent_ids: torch.Tensor,
        task_categories: torch.Tensor,
        agent_categories: torch.Tensor,
        numeric: torch.Tensor,
        wide_indices: torch.Tensor,
        wide_offsets: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """返回 pCTR、pCVR 与 pCTCVR，并由乘法强制保持联合概率不变量。"""
        deep_input = torch.cat((
            self.agent_embedding(agent_ids),
            self.task_category_embedding(task_categories),
            self.agent_category_embedding(agent_categories),
            numeric,
        ), dim=1)
        shared = self.deep(deep_input)
        pctr = torch.sigmoid(self.ctr_head(shared).squeeze(1) + self.wide_ctr(wide_indices, wide_offsets).squeeze(1))
        pcvr = torch.sigmoid(self.cvr_head(shared).squeeze(1) + self.wide_cvr(wide_indices, wide_offsets).squeeze(1))
        # 不单独训练第三个自由输出头；乘法保证 0<=pCTCVR<=pCTR 且语义始终可解释。
        return pctr, pcvr, pctr * pcvr

    def forward_dense_wide(
        self,
        agent_ids: torch.Tensor,
        task_categories: torch.Tensor,
        agent_categories: torch.Tensor,
        numeric: torch.Tensor,
        wide_indices: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """使用固定宽度 Wide 矩阵执行与 ``forward`` 等价的 ONNX 友好计算。

        PyTorch 的 EmbeddingBag offsets 表达不适合作为稳定的跨运行时输入契约；每条样本
        恰有四个 Wide 交叉，因此线上模型直接索引权重并求和，数学结果与 mode=sum 的
        EmbeddingBag 相同。
        """
        deep_input = torch.cat((
            self.agent_embedding(agent_ids),
            self.task_category_embedding(task_categories),
            self.agent_category_embedding(agent_categories),
            numeric,
        ), dim=1)
        shared = self.deep(deep_input)
        wide_ctr = self.wide_ctr.weight[wide_indices].sum(dim=1).squeeze(1)
        wide_cvr = self.wide_cvr.weight[wide_indices].sum(dim=1).squeeze(1)
        pctr = torch.sigmoid(self.ctr_head(shared).squeeze(1) + wide_ctr)
        pcvr = torch.sigmoid(self.cvr_head(shared).squeeze(1) + wide_cvr)
        return pctr, pcvr, pctr * pcvr


class ONNXExportModel(nn.Module):
    """只暴露线上需要的五个输入，隐藏 PyTorch 训练专用的 EmbeddingBag offsets。"""

    def __init__(self, source: WideDeepESMM) -> None:
        super().__init__()
        self.source = source

    def forward(
        self,
        agent_ids: torch.Tensor,
        task_categories: torch.Tensor,
        agent_categories: torch.Tensor,
        numeric: torch.Tensor,
        wide_indices: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        """返回满足 ``pCTCVR = pCTR × pCVR`` 的三个稳定 ONNX 输出。"""
        return self.source.forward_dense_wide(
            agent_ids, task_categories, agent_categories, numeric, wide_indices,
        )



def wide_crosses(task_category: str, agent_category: str, price_ratio: float, position: int, buckets: int) -> tuple[int, ...]:
    """把少量可解释交叉映射到固定桶，0 永远保留给 padding。

    使用 SHA-256 而非 Python ``hash``，是因为后者默认带进程随机盐；若训练和服务进程
    得到不同桶，相同请求会使用完全不同的 Wide 参数。哈希冲突属于受控参数共享，不会
    改变输入契约。
    """
    values = (
        f"task={task_category}",
        f"agent={agent_category}",
        f"task_agent={task_category}:{agent_category}",
        f"price_position={min(4, int(price_ratio * 2))}:{position}",
    )
    return tuple(1 + int.from_bytes(hashlib.sha256(value.encode()).digest()[:8], "big") % (buckets - 1) for value in values)
