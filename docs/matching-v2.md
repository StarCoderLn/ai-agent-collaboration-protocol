# 匹配 V2：Wide & Deep + ESMM

V0、V1、V2 是匹配算法的迭代版本，当前最终实现是一个 V2 管道：先统一执行分类、准入、
币种、截止时间与冷启动报价硬约束，再使用 OpenAI Embedding 和 pgvector 从合格 Agent
中召回 30 名，最后由 Wide & Deep + ESMM 对完整召回池计算 `pCTR`、`pCVR` 与
`pCTCVR`，按联合成功概率返回 Top-3。正式模式只接受数据库注册为 `active + real` 的
同版本模型；模型不可用、版本漂移或未获发布授权时 fail closed，不会静默退回旧算法。

旧规则排序和语义排序记录继续保留用于历史审计与 shadow 对照，不再作为最终产品中的三套
可选算法。当前受控模型由 synthetic 数据训练，只能用于工程验收；真实数据未达到发布门槛
之前，项目不能声称已经完成生产切流。

## 训练事实

普通任务和多 Agent 工作流节点都只有在候选卡可视面积达到 50% 且持续一秒后才写入
曝光。客户端重试复用同一 `eventKey`，数据库再次校验任务、可选节点、冻结候选和事件
内容，候选生成本身不算曝光。
训练导出只纳入已经选人的记录：未选择候选可形成 CTR 负样本；选中候选只有明确拒单，
或已经接单且任务成功时才形成完整标签。执行中、争议、取消、平台故障和结果未知的记录
属于删失样本，不会被标为 Agent 履约失败。

每个样本使用匹配时冻结的语义相似度、标签覆盖、价格比、质量、置信度、响应时间、负载、
历史准时率、返工率、争议率、准入分、实际展示位置和新 Agent 标识。训练阶段不会回查
未来评分。仿真数据保存在独立 JSONL 中并标记 `synthetic`，数据库约束禁止仿真模型进入
`active` 正式排序。

## 模型与冷启动

PyTorch 模型由 Wide 交叉项与 Deep Embedding/连续特征共同组成。ESMM 在全曝光样本上
同时优化 CTR BCE 与 CTCVR BCE，使用 `pCTCVR = pCTR × pCVR` 保持概率关系。训练时将
20% Agent ID 随机替换为 UNK；时间切分后的新 Agent 也走同一 UNK 参数。仿真冒烟包含
后期入驻 Agent 和最低曝光保障，用来证明冷启动路径存在，不能当作线上效果结论。

## 训练与发布

`MATCHING_V2_TRAINING_ENABLED=true` 时，Temporal 在独立 Task Queue 中运行夜间训练：

1. PostgreSQL 按时间窗导出真实曝光和已完成漏斗，少于 300 条时记录 `skipped` 并等待下一夜；
2. Activity 用参数数组调用 `uv run aicp-matching-v2 train`，缓存固定在 `/tmp`；
3. 制品保存数据集哈希、特征版本、词表、归一化参数和验证/测试指标；
4. 数据库原子注册 `candidate` 模型与训练终态。

训练在 PyTorch 中完成并导出 `.onnx` 制品；导出阶段必须逐项比较 PyTorch 与 ONNX 输出，
数值漂移超限就拒绝注册。服务在创建 ONNX Runtime Session 前校验制品 SHA-256，并从模型
metadata 读取版本、词表、归一化参数和特征契约。Dispatch Engine 启用 shadow 时先通过
`/health` 核对内存版本；启用正式排序时还必须从 PostgreSQL 证明同版本模型为
`active + real`。HTTP 边界校验响应 Agent 集合、概率范围、`pCTCVR=pCTR×pCVR` 和排名
唯一性。正式排序同步失败会关闭本次匹配；影子 Worker 失败只重试自己的私有任务。

正式切流仍需真实数据满足门槛，并比较旧稳定排序与 V2 的 NDCG@3、CTR/CTCVR LogLoss、
冷启动 NDCG@3、延迟和分组公平性。代码没有自动提升 `active` 的入口；发布是显式、可审计
的运营动作，回滚目标是上一个稳定模型版本。

## 受控种子训练结果

2026-09-14 使用固定随机种子按完整“召回候选 → 展示 Top-3 → 选中 → 接单 → 成功”漏斗
生成 10,000 个任务和 30,000 条曝光。100 个虚拟 Agent 均匀覆盖平台当前十个正式分类，
训练字段直接使用分类 UUID，避免真实请求的类别特征全部落入 UNK；其中包含 9,904 次
选中、5,614 次接单、3,527 次成功和 7,143 条新 Agent 曝光。

重新导出得到 ONNX 模型 `matching-v2-20260914153930-81cb1ad0`：测试集 NDCG@3 为 0.7436，冷启动
任务 NDCG@3 为 0.7436，CTR LogLoss 为 0.6228，CTCVR LogLoss 为 0.3678。冷启动指标
按“包含训练期未见 Agent 的完整候选集”计算，不能只保留未见 Agent 后把单候选任务计为
满分。制品已在本机
仅能注册为 `synthetic/shadow`。新 ONNX 制品 SHA-256 为
`06a1671458f0e1b54da89f0c9d4fb0a64b45cdeeb2860907d43f42cfc7a3519e`，已经通过真实
ONNX Runtime `/health`、`/score` 以及 Go HTTP Scorer 接缝验证。既有 shadow 组合验收还
覆盖“OpenAI Embedding → pgvector 召回 → 私有影子任务 → Go Worker → PostgreSQL 原子
落库”。注册表保持零个 `active` 模型；这些指标只证明模型、UNK 和服务链路可运行，不能
作为真实用户效果或正式切流依据。

## 离线影子对照

最后 15% 时间窗口包含 4,500 条曝光、1,500 个任务。使用完全相同的候选集比较 V1 原始
位置和 V2 `pCTCVR` 排名后，V2 的 Top-1 最终成功率为 19.27%，高于 V1 的 17.33%；
但 V2 NDCG@3 为 0.7436，低于 V1 的 0.7651，Top-1 选中率也从 44.53% 降至 39.33%。
概率校准方面，V2 CTR LogLoss 0.6228 优于常量基线 0.6345，CTCVR LogLoss 0.3678
优于常量基线 0.3820。

因此当前模型只证明“更偏向最终成功”的信号已经学到，尚不能证明综合排序全面优于 V1，
继续保持 shadow。旧版本 `matching-v2-20260914083056-81cb1ad0` 因冷启动指标分组口径会
产生虚高结果而标记为 rejected，审计记录保留但不再接收影子任务。

V1→V2 公网组合验收默认不会随普通测试启动外部模型。运行本机 V2 服务后，显式提供下列
配置即可重复验证完整接缝；测试只发送代码内固定的合成任务和 Agent 描述，只清理自己的
固定 UUID，不删除其他数据：

```bash
DATABASE_URL=postgres://... \
MATCHING_V2_LIVE_MODEL_URL=http://127.0.0.1:3290 \
MATCHING_V2_LIVE_MODEL_VERSION=matching-v2-20260914153930-81cb1ad0 \
OPENAI_API_KEY=... \
go test ./internal/store -run TestMatchingV1ToV2WorkerLiveModels -count=1 -v
```
