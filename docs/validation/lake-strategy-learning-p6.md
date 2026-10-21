# P6 有界快照优化本地验证

2026-10-21，从 P5 #48 合入后的 `origin/develop@1d2df2cec90a2f777a8ab9214a619c861d1ed13e` 创建 `codex/strategy-learning-p6`，PR 目标 develop。功能与边界见 [P6 设计](../design/strategy-learning-optimization-v4.md)。

最终运行代码提交为 `8fd7cfc2d425ef59e0c890d4de54f7ab96100a3c`，之后只补充本文及设计验收说明。所有模型集成只使用无密钥本机 provider 模拟，不访问生产凭据、真实服务或付费模型。

| 检查 | 实际结果 |
| --- | --- |
| `go test ./...` | 最终代码通过，Web 136.919s；包含已有 P0–P5 及新增优化回归 |
| `go vet ./...` | 最终代码通过，无输出 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy` | 完整实现阶段通过，AI 133.997s、Web 337.952s、strategy 1.356s |
| `go test -race ./internal/web -run '^TestStrategyOptimization' -count=1` | 最终恢复边界通过，30.511s；其后只调整能力元数据和页内确认，定向测试再通过 7.351s |
| `python3 scripts/check_adk_runtime_boundary.py` | 最终代码生产入口及 provider AST 检查通过 |
| `corepack pnpm check`、`corepack pnpm test:frontend`、`corepack pnpm build:web`（web-agent） | 最终类型检查、355/355 前端测试、构建通过；保留既有大 bundle 提示 |
| `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake_desktop.sh --dev --install` | 最终代码 macOS arm64 签名构建安装通过，build-origin dirty=false，gitHead 与测试 SHA 一致，backendSHA256 与签名 bin/lake 一致 |
| `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app` | 通过；正常退出 Dev 后替换 bundle，未操作正式版 Lake |

定向集成覆盖：5 个独立 ADK 运行与 2 次无工具辅助调用，总计 12 次 provider 请求；合成正文必须重新运行，开发改进/保留平局与保留退化分别展示；无进展、无候选、正文相同、总请求预算、未知辅助 usage 保守计费、运行中取消/来源撤回/关闭/清理阻止迟到正文。解析器拒绝伪造 run ID、未知授权字段、重复字段、null 必填解释和尾随文档；关闭隔离优化、错误场景分组/重复数、修订预算不足均不派发请求。

泄漏检查直接断言辅助请求没有工具/会话历史、保留场景任务或 Redis 观察、隐藏判据或评估分数；确实包含开发运行已读取的 720GB 合成观察，避免冻结 JSON 反序列化后丢失私有材料而伪称使用证据。经验摘要只含开发集元数据。跨项目报告读取拒绝；保存幂等、不自动采用、旧验证等级不变；真实评估来源和 composed_from/tested_by/proposed_to_fix/compared_with 血缘可回溯。

跨进程测试运行实际 ADK/provider：模型请求期间杀死进程，辅助调用保留 unknown、未执行样本保留，不自动或显式重放未知请求。另用真实子进程在开发运行结果/阶段保存后、提案结果已保存但阶段未推进时、最后保留运行结果已保存但阶段未推进时退出；重启只等待，用户显式继续后复用原运行和结果，总请求仍为 12。最后一种在请求额度已耗尽时只完成业务汇总，不增加模型请求。多次重启不延长等待 TTL；等待过期、活动预算耗尽和设置 generation 变化拒绝继续。v3 升级前 0600 兼容副本、v4 重新打开幂等及 DDL 冲突时 ALTER/标记一起回滚也通过。

原生 Lake Dev 最终验收使用独立临时 Home `/var/folders/vd/tpn95_y535g6h9b4fkgmlc380000gn/T/lake-p6-ui-nd1oqosv`。初始确认默认 correctEnabled=false；测试配置全局允许但项目隔离优化关闭，界面按钮不可用。手动开启并保存项目开关、选择种子 v1、SL-001 开发场景与 SL-014 保留场景，再从界面启动优化。完成 5 个独立运行、10 次 Actor 请求、2 次提案/合成请求，共 2400 模拟 tokens；报告开发胜出 1、保留平局 1、基线未通过样本仍可见。

Dev 验收发现原生 WebView 未展示 window.confirm，原保存点击无效；已改为页内明确确认，并在最终 SHA 重新完整验收：打开确认面板、确认保存为 v2，旧版可见且仍为 user_confirmed，新版标为“已通过指定快照固定检查，非通用验证”，采用绑定仍为空。清理确认面板可返回报告，不误触清理。前端能力元数据同时明确 correctMode=isolated_snapshots、onlineCorrect=false。

最终 UI 验证浅色/深色、850×600 窗口、报告正文换行/卡片裁切、AppSelect 菜单/键盘 Escape 焦点和共享圆角。恢复浅色和原窗口；经原生 SavePanel 保存并解析 JSON，核对 5 个不同 runtimeId/nonce、同场景 resetHash 相同、A 无学习资产、B/C 实际注入不同临时候选、输出额度 2048、调用/用量及保存版本，无 frozenJSON/sharedContext/leaseToken。

正常退出 Dev 后，用同一签名后端重启该测试 Home，报告/12 次请求/v2/未采用绑定/血缘保留，无自动模型请求。通过 API 清理实验，输入/辅助候选/报告/经验原文清空，5 个实验目录清除；再重启确认清理持久化、审计身份保留、schemaVersion=4、integrity_check=ok。用户明确保存的 v2 正文单独保留，但评估来源已不可用；删除该资产才能清理正式资产正文。测试结束后退出临时进程。

未验证 Windows/Linux、真实付费模型、其他协议/原生推理重放、真实服务故障恢复和在线普通任务纠错。本次模拟 provider 的固定输出只验证控制流/隔离/计量，不证明实际模型优化收益。develop PR 不运行自动 CI，未手动触发、合并或发布；v4 回退按设计使用另一 Home 的兼容升级前副本。
