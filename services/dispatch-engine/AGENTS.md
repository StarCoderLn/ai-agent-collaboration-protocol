# 项目踩坑与教训(AGENTS.md)
- [1.agent-protocol-contract/T-001] Go module path 须对齐实际 git remote(services/<name>)，否则跨服务 import 解析失败。
- [1.agent-protocol-contract/T-005,T-008] 给已有字段加标记位/新增列，仅改签名或建列不够，须同步扩展 store 写入接口参数回填，否则被 DB 默认值掩盖、字段无法落库。
- [1.agent-protocol-contract/T-006] 契约测试须经真实入口触发，不能只断言静态错误码或默认值。
