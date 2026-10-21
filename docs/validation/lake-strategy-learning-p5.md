# P5 隔离快照评估本地验证

2026-10-21，基于 P4 PR #46 合入后的 `origin/develop@46a09d743e3adc000e5a0ab1b274a67f66bf5443`，分支 `codex/strategy-learning-p5`，PR 目标 develop。设计边界见 [P5 说明](../design/strategy-learning-experiments-v3.md)。

当前定向验证已通过：15 个合成场景各自 A/B 实际 ADK 运行（30 个独立 session、58 次模拟 provider 请求）、相同复位 hash/不同 nonce、B 精确资产注入、三组保留集配对与越界退化、共享记忆/Skill 快照与 Skill 源变更、整场请求/token 预算、未知 usage 保守计费、取消/开关/撤回/归档阻止迟到结果、跨项目隔离、删除内容、真实 SDK 模型调用期间杀死子进程且不重放、v2 升级前备份及 DDL 失败回滚。旧策略回归及 P0 关闭态样例继续通过。

运行代码最终测试提交：`01efdcbd812f17d0e5e81311861eb39caf500569`；其后的提交仅补充本验证记录。模型额度修正前的完整竞态基线为 `f208bc5cb365b7df4d0e3c17903833acc17a5ea9`。

| 验证 | 结果 |
| --- | --- |
| `go test ./...` | 完整通过；最终代码再运行通过 |
| `go vet ./...` | 最终代码通过 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy` | 通过，AI 136.054s、Web 368.828s、strategy 1.984s；额度修正后另跑全部 `TestStrategyExperiment` 竞态通过（24.235s） |
| `go test ./internal/web -run '^TestStrategyExperiment' -count=1` | 最终代码通过（6.073s），包含模型默认/缓存/显式容量冻结验证 |
| `python3 scripts/check_adk_runtime_boundary.py` | 最终代码 AST/生产入口检查通过 |
| `corepack pnpm check`、`corepack pnpm test:frontend`、`corepack pnpm build:web`（`web-agent`） | 类型检查、354/354 测试和构建通过；保留既有大 bundle 提示 |
| `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake_desktop.sh --dev --install` | macOS arm64 签名构建安装通过；build-origin gitHead 与最终代码 SHA 相同、dirty=false、backend SHA256 与签名二进制一致 |
| `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app` | 通过 |

Lake Dev 原生应用在独立临时 Home `/var/folders/vd/tpn95_y535g6h9b4fkgmlc380000gn/T/lake-p5-ui-7ti9iznt` 启动，未使用 `.lake`、`.lake-dev` 或正式凭据。配置无密钥的本机模拟 OpenAI provider；通过界面选择精确未采用 v1、SL-001 开发场景与 SL-013 保留场景并启动实验。4 次独立运行、8 次 provider 请求，两个分组各一组平局；全部固定检查通过，B 清单各次确实包含指定版本，A 不含学习资产，同组 resetHash 相同而 runtimeId/nonce 独立。最终 provider 请求和实际清单中的 maxOutput 均为 2048，未发生额外候选学习或自动采用。

从原生 SavePanel 保存并解析脱敏 JSON，核对全部运行、分组、实际注入与复位证据；无 frozenJSON、共享原文或租约字段。正常退出 Dev 后，用同一签名后端独立重启该测试 Home，完成报告仍为 succeeded/8 次请求，无模型重放。清理实验后输入/报告原文为空、审计身份保留，4 个独立实验目录被清除；再重启确认清理持久化，SQLite integrity_check=ok。测试完成后退出临时进程。

UI 在实现提交 `f208bc5` 验收浅色/深色、850×600 窗口、报告卡片换行/滚动、AppSelect 展开及键盘 Escape 焦点、共享圆角和原生导出；恢复浅色及窗口。最终提交仅修正后端模型额度，重复原生启动、界面提交/报告、JSON 导出、重启和清理验收通过。

此处的夹具是快照模拟，不是实际服务故障注入/恢复；未访问真实付费模型或生产资源。未验证 Windows/Linux、其他模型协议/原生推理重放及真实服务恢复，不以本次固定检查宣称策略普遍提升。日常 develop PR 无自动 CI，未手动触发或合并/发布。v3 回退需使用私有升级前兼容副本和独立 Home，详见设计说明。
