# Matching V2

本模块实现最终匹配 V2 的 Wide & Deep + ESMM 排序服务。上游先执行资格与资金硬约束并
通过 pgvector 召回候选，本模块只对冻结召回池评分，不能创建候选或修改托管事实。

```bash
uv sync
uv run aicp-matching-v2 simulate --output ../../.local/matching-v2/synthetic.jsonl
uv run aicp-matching-v2 train \
  --input ../../.local/matching-v2/synthetic.jsonl \
  --artifact-dir ../../.local/matching-v2/artifacts
uv run aicp-matching-v2 compare \
  --input ../../.local/matching-v2/synthetic.jsonl \
  --artifact ../../.local/matching-v2/artifacts/<version>.onnx \
  --sha256 <matching_v2_model_versions.artifact_sha256>
uv run aicp-matching-v2 serve \
  --artifact ../../.local/matching-v2/artifacts/<version>.onnx \
  --sha256 <matching_v2_model_versions.artifact_sha256> \
  --address 127.0.0.1 --port 3290
```

仿真数据固定标记为 `synthetic`，只能生成 candidate/shadow 模型。是否允许正式发布由
PostgreSQL 模型注册表再次校验，避免本地训练参数绕过数据来源门禁。

默认参数会生成 10,000 个任务、100 个虚拟 Agent 和 30,000 条 Top-3 曝光。Agent 均匀
覆盖平台十个正式分类并使用相同分类 UUID，行为依次经过展示、选中、接单和成功概率，
而不是直接随机填写三个互不相关的标签。它适合冷启动预训练和工程验收，不能冒充外部
用户真实反馈。

`compare` 会先校验制品中记录的数据集 SHA-256，再在最后 15% 时间测试集上用相同候选
比较 V1 原始位置与 V2 `pCTCVR` 排名。输出同时包含 Top-1 选中/成功率、NDCG@3 和
常量概率 LogLoss，避免只看一个对当前模型有利的指标。

当前 ONNX 制品 `matching-v2-20260914153930-81cb1ad0` 的 SHA-256 为
`06a1671458f0e1b54da89f0c9d4fb0a64b45cdeeb2860907d43f42cfc7a3519e`。它已通过
ONNX Runtime `/health`、`/score` 与 Go HTTP Scorer 的真实本机契约验收。该模型仍是
`synthetic/shadow`，不能推断线上收益；数据库和 Dispatch Engine 双重禁止它进入
`active`。冷启动 NDCG 按包含未见 Agent 的完整任务候选集计算，避免只评估单个新 Agent
时产生虚高分数。
