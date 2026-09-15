"""AICP 匹配 V2 的仿真、训练与影子推理边界。"""

# 特征版本描述线上评分请求；字段含义或归一化方式变化时必须升级，防止旧制品静默误读。
FEATURE_SCHEMA_VERSION = "matching-v2.features.v1"
# 数据集版本描述 JSONL 单行契约；训练和推理共用解析器，避免离线与在线特征漂移。
DATASET_SCHEMA_VERSION = "matching-v2.dataset.v1"
