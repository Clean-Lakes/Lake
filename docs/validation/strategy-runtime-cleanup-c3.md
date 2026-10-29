# C3 运行清理验收

日期：2026-10-29，macOS arm64。对应 [C3 契约](../design/strategy-runtime-cleanup-c3.md)。功能保持实验，不涉及 master、发布或安装包。

## 基线与源码

已按本次授权审查并 squash 合并 [PR #116](https://github.com/Clean-Lakes/Lake/pull/116)。原 head `af594dacd5a8320b7ac4c4d100cd70475a8770db` 与合并 `cd75e2c7d0acb71e61e73d19bd12ceec92486c5d` 树一致；补跑 N5 AI/Web 回归通过，删除远端和本地 `codex/natural-memory-recall-n5`。

C3 从上述 develop 独立开发。期间 develop 合入 #115，已同步到 `origin/develop@16483bd22f8ce60999cdcf1d16fbaf16a9fda42a`，没有冲突。最终全量测试与签名 Dev 源码 **`9033353bec358cc688c73bc1f850949c5169be0c`**，构建 dirty=false，二进制 SHA256 对照及 codesign 严格检查通过；随后只补本验收/证据和计划文档。原生 Swift 没有由 C3 修改，使用已安装 Dev 窗口连接新 Go/Web 后端，没有制作 ZIP/DMG 或更换生产应用。

## 本地检查

完整命令和结果见 [checks.json](strategy-runtime-c3/checks.json)。

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1 -timeout=8m` | 全部通过，AI 74.056s，Web 213.659s |
| AI/Web 有关 C3、自然记忆、旧策略、上下文、官方恢复等 race | 通过，AI 36.029s，Web 65.905s |
| `go vet ./...`、ADK 运行边界 AST 检查 | 通过 |
| web-agent 中固定 pnpm 类型检查与前端测试 | 551 通过，0 失败/跳过；此前基线 543 项也通过，不混用两个数量 |
| Windows amd64 后端交叉构建 | 通过；没有 Windows 原生运行/手动 CI |
| `scripts/run_lake_dev.sh` | 新 Web 构建、签名后端与固定 Dev Home 启动通过；前端仍有既有 chunk 大小提醒，不影响完成 |

增加或改成真实链路的断言包括：普通请求在 artifact 写入触发器故障下仍完成且零新清单；显式诊断保存失败仍派发正常请求；真实 canonical 持久化故障在模型前失败；准确采用撤回在关闭诊断时仍阻止后续工具；旧 actor 零回调/目录/模型；纠正表达及真实工具失败不生成旧 outbox；准确旧快照 hash 和 ACK 幂等；主机 inspect 真实失败后只派发一次；生产 AST 不再引用旧控制器/候选采集/配置字段。

17 组冻结提示词字节 hash 来自 C3 改动前的 `cd75e2c7`，只归一化 OS，全部一致。旧 SQL 迁移和 hash 输入未变。原审批、取消、unknown 恢复、主机 runtime、Skills、项目记忆、N1～N5 与 Pilot 回归仍包含在全量检查中。没有删除失败测试或把旧收益 inconclusive 改成成功；原真实 P8/R5 actor 脚本显式提示执行已退役，不读取模型凭据后尝试新实验。

## 固定 Home 的 Dev 升级与冒烟

固定 `~/.lake-dev`，使用已有 deepseek-flash，仅新增虚构测试会话，不修改真实来源和既有供应商设置。停止旧 Dev 后，SQLite backup API 对业务/ADK 库建立私有一致性备份；首次 C3 启动、发送新消息前，**51 张旧策略/自然记忆表和 2 张 ADK 历史表的全部行 hash 一致**。没有删表、正文或未知记录。备份只留本机，不含供应商凭据，不提交数据库。

先在 C3 初版 `3dd66e99` 完成两次冒烟，再在同步最新 develop 后的 `9033353b` 各用一个新会话重跑：[dev.json](strategy-runtime-c3/dev.json)。

| 场景 | 最终结果 |
| --- | --- |
| 已有项目偏好要求以【协调偏好】开头，新会话问 2+2 | 回复「【协调偏好】2 加 2 等于 4。」；准备记录指向原准确偏好，project 范围 |
| 另一个新会话明确要求只回复数字4 | 回复「4」；当前明确要求覆盖仍已准备的项目偏好 |
| 两次请求前后统计 | prompt-manifest artifact 保持 187；nativeCorrection 保持 10；无新实验清单/纠错卡/资源操作，两个新会话历史清单均为空 |
| 读取旧 N5 会话 | 原 1 条请求清单可通过鉴权 API 读取，原生 Dev 下拉也能选择并显示其时间/省略记录 |
| 数据和设置 | 两库 integrity_check=ok；用户全局/测试项目自动积累仍关闭，测试项目使用仍开启；没有改变既有开关 |

最终两次主请求实际报告 36,539 tokens（输入36,438、输出101），不是零成本演示，也不是分类质量或业务收益评测。因为本阶段没有改分类器、样本或提炼契约，未重跑 N5 的 180 次真实意图分类或旧研究试点；不能用此冒烟代替其质量结论。

macOS 原生 Dev 逐项检查记忆仍带实验标签、兼容默认折叠、历史清单读取、说明换行、共享下拉键盘选择和焦点边框、浅/深色及 1003×853 窄窗口，无新增裁切或横向溢出。记录：[偏好复用](strategy-runtime-c3/recall.jpg)、[旧清单/浅色](strategy-runtime-c3/history-light.jpg)、[深色](strategy-runtime-c3/history-dark.jpg)、[窄窗口](strategy-runtime-c3/history-narrow.jpg)。外观已恢复浅色和原窗口大小，Dev 留在新偏好复用会话。

## 剩余项与回退

复杂条件旧资产仍需原最小选择/撤回适配器；旧预算/报告类型、SQL、unknown 恢复及历史清单不删除。[清理计划](../../plan/refactor-harness-inspired-cleanup-1.md) C4 的 README/旧脚本/CI 引用、最终升级/回退及平台集成矩阵仍待实施，不能把 C3 当成整个清理完成。Windows 本阶段仅交叉构建；N5 的一次 CI 授权已按其阶段完成，未复用于 C3。自然记忆默认关闭和实验状态不变，运维 V2 也未开启。

本次没有数据库迁移；代码可经 PR revert 回退。不要把旧数据库覆盖到当前 Home，尤其不能丢失新的撤回/操作记录；任意旧二进制和活动操作的回退仍须在离线副本验证。C3 的可选诊断策略不能被扩展成吞掉真实会话、授权或操作账本故障。
