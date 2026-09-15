"""把训练模型发布为带自描述元数据的 ONNX 制品。"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch

from .model import ONNXExportModel, WideDeepESMM

METADATA_KEY = "aicp.matching.metadata"
ONNX_OPSET = 17


def export_onnx(model: WideDeepESMM, metadata: dict[str, object], artifact_path: Path) -> None:
    """导出动态批量 ONNX，并在文件内写入推理所需的完整元数据。

    词表、归一化参数和模型参数必须属于同一哈希锁定制品。若另放 JSON 旁路文件，部署时
    很容易组合出“新模型 + 旧词表”的静默错误，因此这里使用 ONNX metadata_props。
    """
    model.eval()
    wrapper = ONNXExportModel(model).eval()
    dummy = (
        torch.tensor([0, 1], dtype=torch.long),
        torch.tensor([0, 1], dtype=torch.long),
        torch.tensor([0, 1], dtype=torch.long),
        torch.zeros((2, int(metadata["modelConfig"]["numericCount"])), dtype=torch.float32),
        torch.zeros((2, 4), dtype=torch.long),
    )
    torch.onnx.export(
        wrapper,
        dummy,
        artifact_path,
        input_names=["agent_ids", "task_categories", "agent_categories", "numeric", "wide_indices"],
        output_names=["pctr", "pcvr", "pctcvr"],
        dynamic_axes={name: {0: "batch"} for name in (
            "agent_ids", "task_categories", "agent_categories", "numeric", "wide_indices",
            "pctr", "pcvr", "pctcvr",
        )},
        opset_version=ONNX_OPSET,
        do_constant_folding=True,
    )
    document = onnx.load(artifact_path)
    document.metadata_props.add(key=METADATA_KEY, value=json.dumps(metadata, separators=(",", ":"), sort_keys=True))
    onnx.checker.check_model(document)
    onnx.save(document, artifact_path)


def assert_onnx_matches_pytorch(model: WideDeepESMM, artifact_path: Path, inputs: dict[str, np.ndarray]) -> None:
    """在发布前比较两个运行时，阻止导出算子或维度变化造成静默分数漂移。"""
    model.eval()
    with torch.no_grad():
        expected = model.forward_dense_wide(*(torch.from_numpy(inputs[name]) for name in (
            "agent_ids", "task_categories", "agent_categories", "numeric", "wide_indices",
        )))
    session = ort.InferenceSession(str(artifact_path), providers=["CPUExecutionProvider"])
    actual = session.run(["pctr", "pcvr", "pctcvr"], inputs)
    for torch_value, onnx_value in zip(expected, actual):
		if not np.allclose(torch_value.numpy(), onnx_value, rtol=1e-5, atol=1e-6):
			raise ValueError("MATCHING_ONNX_PARITY_FAILED")
