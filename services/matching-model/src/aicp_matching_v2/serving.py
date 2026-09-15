"""本机影子推理 HTTP 边界；请求只接受版本化特征，不读取业务数据库。"""

from __future__ import annotations

import json
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import onnxruntime as ort

from . import FEATURE_SCHEMA_VERSION
from .artifact import METADATA_KEY
from .features import encode_features
from .schema import Example, parse_example


class Predictor:
    """加载哈希锁定的 ONNX 制品，并提供与数据库无关的批量在线评分。"""

    def __init__(self, artifact: Path | str, expected_sha256: str) -> None:
        """先验证文件身份，再创建 ONNX Runtime Session 并读取内嵌元数据。"""
        artifact_path = Path(artifact)
        actual_sha256 = hashlib.sha256(artifact_path.read_bytes()).hexdigest()
        if len(expected_sha256) != 64 or actual_sha256 != expected_sha256.lower():
            raise ValueError("MATCHING_MODEL_ARTIFACT_HASH_MISMATCH")
        if artifact_path.suffix != ".onnx":
            raise ValueError("MATCHING_MODEL_ARTIFACT_FORMAT_UNSUPPORTED")
        # 显式固定 CPU provider，避免开发机安装的其他 provider 改变数值或部署可用性。
        self.session = ort.InferenceSession(str(artifact_path), providers=["CPUExecutionProvider"])
        encoded_metadata = self.session.get_modelmeta().custom_metadata_map.get(METADATA_KEY)
        if encoded_metadata is None:
            raise ValueError("MATCHING_MODEL_METADATA_MISSING")
        metadata = json.loads(encoded_metadata)
        if metadata["featureSchemaVersion"] != FEATURE_SCHEMA_VERSION:
            raise ValueError("MATCHING_MODEL_FEATURE_SCHEMA_UNSUPPORTED")
        if metadata.get("modelConfig", {}).get("artifactFormat") != "onnx":
            raise ValueError("MATCHING_MODEL_ARTIFACT_FORMAT_UNSUPPORTED")
        self.metadata = metadata

    def score(self, raw_candidates: list[dict[str, Any]]) -> list[dict[str, object]]:
        """校验并批量评分同一召回池，按联合成功概率生成稳定影子名次。"""
        examples = [parse_example(candidate, require_labels=False) for candidate in raw_candidates]
        pctr, pcvr, pctcvr = self.predict_probabilities(examples)
        scores = [
            {"agentId": item.agent_id, "pctr": float(ctr), "pcvr": float(cvr), "pctcvr": float(joint)}
            for item, ctr, cvr, joint in zip(examples, pctr, pcvr, pctcvr)
        ]
        # Agent ID 只作为同分稳定决胜键，保证重试与多实例服务返回完全相同的 rank。
        scores.sort(key=lambda item: (-float(item["pctcvr"]), str(item["agentId"])))
        for index, score in enumerate(scores, start=1):
            score["shadowRank"] = index
        return scores

    def predict_probabilities(self, examples: list[Example]) -> tuple[list[float], list[float], list[float]]:
        """按输入顺序返回概率，供在线排序和离线评估共享唯一 ONNX 执行路径。"""
        # 服务必须复用训练制品保存的词表和归一化统计；重新从当前批次计算会造成训练/推理
        # 偏移，也会让同一候选分数依赖同批次还出现了谁。
        batch = encode_features(
            examples, self.metadata["agentVocabulary"], self.metadata["categoryVocabulary"],
            self.metadata["numericMeans"], self.metadata["numericScales"], mask_unknown=False,
        )
        pctr, pcvr, pctcvr = self.session.run(["pctr", "pcvr", "pctcvr"], batch)
        return pctr.tolist(), pcvr.tolist(), pctcvr.tolist()


def serve(predictor: Predictor, address: str, port: int) -> None:
    """启动最小 HTTP 边界；业务鉴权和任务归属由调用它的 Dispatch Engine 负责。"""

    class Handler(BaseHTTPRequestHandler):
        """仅公开健康检查和评分两个端点，并关闭可能泄露特征的默认访问日志。"""

        def do_GET(self) -> None:  # noqa: N802 - 标准库回调名称不可改写
            """返回内存模型版本，供发布 shadow 前与注册表进行一致性校验。"""
            if self.path != "/health":
                self.send_error(404)
                return
            self.respond(200, {"status": "ok", "modelVersion": predictor.metadata["version"]})

        def do_POST(self) -> None:  # noqa: N802 - 标准库回调名称不可改写
            """接收一个版本化召回池，整体成功或整体返回稳定 422 错误。"""
            if self.path != "/score":
                self.send_error(404)
                return
            try:
                # 一兆上限防止错误代理或恶意调用把影子服务变成无界内存入口；正式召回池
                # 最多 50 名候选，正常请求远小于此限制。
                length = int(self.headers.get("content-length", "0"))
                if length <= 0 or length > 1 << 20:
                    raise ValueError("MATCHING_SCORE_BODY_INVALID")
                raw = json.loads(self.rfile.read(length))
                if raw.get("featureSchemaVersion") != FEATURE_SCHEMA_VERSION or not isinstance(raw.get("candidates"), list):
                    raise ValueError("MATCHING_SCORE_SCHEMA_INVALID")
                self.respond(200, {"modelVersion": predictor.metadata["version"], "scores": predictor.score(raw["candidates"])})
            except (ValueError, TypeError, json.JSONDecodeError):
                # 对外只暴露稳定错误码，不返回特征正文、制品路径或 Python 异常细节。
                self.respond(422, {"errorCode": "MATCHING_SCORE_INVALID"})

        def log_message(self, _format: str, *_args: object) -> None:
            """禁用标准库默认访问日志，避免未来路径扩展意外泄露任务信息。"""
            # 特征可能来自私密任务，默认 HTTP 日志不能输出路径参数或请求正文。
            return

        def respond(self, status: int, body: dict[str, object]) -> None:
            """集中生成严格 JSON 响应，使健康检查和评分具有相同传输语义。"""
            encoded = json.dumps(body, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    # 推理阶段模型只读，线程间不共享可变业务状态；并发请求可以安全复用同一 Predictor。
    ThreadingHTTPServer((address, port), Handler).serve_forever()
