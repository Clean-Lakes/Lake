# P5 隔离快照评估本地验证

2026-10-21，基于 P4 PR #46 合入后的 `origin/develop@46a09d743e3adc000e5a0ab1b274a67f66bf5443`，分支 `codex/strategy-learning-p5`，PR 目标 develop。设计边界见 [P5 说明](../design/strategy-learning-experiments-v3.md)。

当前定向验证已通过：15 个合成场景各自 A/B 实际 ADK 运行（30 个独立 session、58 次模拟 provider 请求）、相同复位 hash/不同 nonce、B 精确资产注入、三组保留集配对与越界退化、共享记忆/Skill 快照与 Skill 源变更、整场请求/token 预算、未知 usage 保守计费、取消/开关/撤回/归档阻止迟到结果、跨项目隔离、删除内容、真实 SDK 模型调用期间杀死子进程且不重放、v2 升级前备份及 DDL 失败回滚。旧策略回归及 P0 关闭态样例继续通过。

完整 Go/竞态、签名 Dev 与最终 SHA 在本次验收结束后补记。此处的夹具是快照模拟，不是实际服务故障注入/恢复；未访问真实付费模型或生产资源。日常 develop PR 无自动 CI，未手动触发或合并/发布。
