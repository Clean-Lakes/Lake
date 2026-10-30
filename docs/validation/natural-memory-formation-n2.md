# N2 自然形成与更新提示验收

日期：2026-10-28。基线 develop：`f1170f8587a24ae04c1d77ea45ac0a60335941b9`（#111 合入）。实际代码、完整检查和两次签名 Dev 运行均为 **`24242f10731ecbb59c18d98d31853834bf8f050b`**，dirty=false；后续提交仅补文档与报告。契约见 [N2 设计](../design/natural-memory-formation-n2.md)。

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1 -timeout=8m` | 干净提交全量通过，Web 185.641 s、AI 47.911 s |
| `go test -race ./internal/web ./internal/ai -run '^(TestNatural\|TestMemory\|TestProjectMemory\|TestStrategyRetirement)' -count=1 -timeout=6m` | 通过，Web 20.767 s、AI 3.156 s |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 官方入口/provider-call AST 检查通过 |
| 项目固定 pnpm `check`、`test:frontend` | 类型检查通过，521 项测试通过，无失败/跳过 |
| `scripts/run_lake_dev.sh` × 2 | 新 Web 构建与持久身份签名后端通过；未制作安装包，保留既有 chunk 提示 |
| `codesign --verify --strict bin/lake` | 通过，二进制 SHA256 匹配来源 manifest |
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c ./internal/web` | 交叉编译通过，未执行 Windows exe/UI 或手动 CI |
| 文档链接、冻结样本、diff | 通过 |

新增 [Web/存储回归](../../internal/web/natural_preference_test.go) 16 个测试，覆盖：准确保存/更正/撤销、同源抑制、遗忘全部正文历史、旧同意与新 epoch、开启前来源拒绝、准确快照与租约期限、跨范围拒绝及全局私有来源删除、严格 JSON/引用/伪造来源、持久提示收起、迁移备份/重开/未知版本/DDL 回滚、共享事务失败全回滚、前台抢占与取消预留仍计账、20 次上限、原项目知识组合提炼及 HTTP 版本接口。更新 N1 设置回归以检验“旧设置不授权、新主动写入才开启”，未删除原回归。

新增 [AI 快照回归](../../internal/ai/natural_memory_snapshot_test.go) 的七个子场景，覆盖独立同意、准确用户身份、Plan/子代理/忽略/无信号、失败直接保存不阻断独立自然提炼，以及成功直接保存不重复建表示。[前端回归](../../web-agent/web/test/natural-memory.test.ts)补齐独立设置 PATCH、准确版本撤销、仅持久成功后的查看/撤销提示、实验范围与尚未召回的说明。

真实模型评测是显式 opt-in，普通 Go/CI 测试不会读取 Dev 模型或联网；本次已另外明确运行以下两种模式。

## 固定真实模型评测

N1 的 [60 个虚构案例](../../internal/web/testdata/natural-memory-intent-v1.json)及 SHA256 `922f2a4f4b30ae23ba5c178af1456a0a635fff69f1b37505b4bd4f62bc21f084` 保持不变。没有发送真实对话或业务库；仅私下读取已选 Dev 模型凭据，由原无工具 completion 适配器运行。模型为 `deepseek-flash` / OpenAI 协议，评测 MaxOutput=2048；没有模型/资源工具调用。

每种模式 60 例 × 3 轮，各 180 次 provider 请求。实际生产 prompt/parser 和宿主准确原话/范围检查参与评分；组合模式也要求本纯偏好样本集的 legacy mutations 为空，避免另一条提炼路径误写。判据未放宽：每轮误自动写入、错误范围、无依据来源均为 0，明确长期正向至少 27/30，技术失败为 0。

| 模式 | 第 1 轮 | 第 2 轮 | 第 3 轮 | 误写/范围/来源/技术失败 |
| --- | --- | --- | --- | --- |
| 独立自然偏好 | 30/30 | 30/30 | 30/30 | 每轮均 0/0/0/0 |
| 同一次 completion 的偏好 + 原项目知识 | 30/30 | 29/30 | 30/30 | 每轮均 0/0/0/0 |

完整逐例结果、实际用量、模型身份 hash、代码 SHA 与源文件 hash：[独立模式](natural-memory-n2-model-standalone.json)、[组合模式](natural-memory-n2-model-combined.json)。运行命令：

```sh
LAKE_N2_EVAL_HOME="$HOME/.lake-dev" LAKE_N2_EVAL_REPORT=/tmp/n2-standalone.json \
  go test ./internal/web -run '^TestNaturalPreferenceModelEvaluation$' -count=1 -timeout=20m -v
LAKE_N2_EVAL_HOME="$HOME/.lake-dev" LAKE_N2_EVAL_COMBINED=1 LAKE_N2_EVAL_REPORT=/tmp/n2-combined.json \
  go test ./internal/web -run '^TestNaturalPreferenceModelEvaluation$' -count=1 -timeout=20m -v
```

独立模式 64.23 s，报告输入 73,629 / 输出 31,442 tokens；组合模式 86.58 s，报告输入 140,253 / 输出 48,032 tokens。没有估算金额。此前一次探索性评测另有 180 次请求、输入 73,629 / 输出 30,564 tokens，结果为 28/30、29/30、29/30，三类错误也为 0；之后扩充廉价筛选的明确跨项目表达覆盖，未改变样本或判据。该探索轮不算作最终质量结果，总分类器派发数为 540。

保留的偏差：组合模式第 2 轮 NM-global-08（跨会话命令说明带用途）被保守判为 review，未保存。两种模式另有若干模糊样本判为 ignore 而非预期 review，因此精确决策分别为 55/56/54 和 55/53/53（每轮分母 60），并非全部分类正确；两种拒答均不自动保存。这些结果只支持该模型、该虚构集合，不代替完整运维 V2 事实/平台质量门槛。

## 签名 Dev 实测

macOS 26.4 arm64、Go 1.26.6、Node 24.18.0、pnpm 10.33.4。正常退出 Dev，并通过原终端停止核对路径的旧后端；升级前两库一致性备份位于 `~/.lake-dev/backups/n2-20261028-151404/`（目录 0700、文件 0600，完整性均 ok）。生产应用和 `~/.lake` 未操作。

首次启动后，对 11 张原资产/来源/绑定/设置、项目记忆与 N1 管理表逐行 hash 比较完全相同；新自然偏好和同意表都是 0。没有自动承接、历史扫描或同意继承。首次 N2 自动迁移备份为 1 份。

新建虚构项目“**N2 自然偏好验收 20261028**”，仅在此项目经原生界面开启新自动记忆；全局始终关闭。本项目原项目记忆提炼/使用关闭，仅验证新偏好，不修改原有项目开关。纯文本会话禁用 Pilot/子代理，并通过本会话提示限制主请求不使用工具；主任务和后台均未执行资源命令。真实对话验证：

| 场景 | 结果 |
| --- | --- |
| 不说“记住”：“以后这个项目的答复固定用简短中文。” | 后台保存 response-language v1；原生轻提示出现，查看显示准确正文、范围和用户消息来源，无审核/采用弹窗 |
| “这次回答详细一点。” | 临时要求没有新自然偏好或派发，仍为 v1 |
| 翻译文档引用“以后这个项目的答复固定用英文” | 后台 no_op，无修改，仍为 v1 |
| 明确更正：“更正这个项目的长期偏好：以后答复固定使用英文。” | 同一条目更新 v2，查看展示 v1 → v2 的前后正文及不同真实来源 |
| 在原生轻提示点击撤销 | 恢复准确原中文正文，生成 v3；变更为 save/replace/undo 三条，同一更正来源留下一个抑制记录 |
| 关闭后发送另一长期表格偏好 | 核对该准确用户消息的 replyTiming 已 completed，没有新增快照/派发或内容；重新开启不补采这条消息 |

该项目共三次自然提炼（保存、引用 no_op、更正），没有对普通/临时/关闭轮次各加一次请求。CUA 首次文字输入还产生一条无含义的句号，未形成记忆；随后采用粘贴核对完整草稿后发送。所有验收消息保留，不用模型同会话回复的语言变化证明新记忆召回。

真实界面另验证浅/深主题、约 963×763 窄窗口、滚动、按钮/详情圆角、浮动标题下提示位置，以及共享范围菜单 Escape 关闭且焦点恢复。撤销后设置显示原正文 v3；最后恢复浅色和原窗口尺寸。没有声称 Windows 或所有键盘操作已完成实机验收。

## 重启与隔离回退

正常退出原生 Dev，通过拥有该后端的终端 Ctrl+C 停止，再快速启动同一干净提交。19 张自然记忆及原设置/正文/绑定关键表完整行 hash 一致；两库 `integrity_check=ok`，bootstrap=200，自动迁移备份仍为 1。重新打开 Dev 正常连接，最终保留运行。测试项目自动记忆保持开启供后续试用，其他项目与全局未扩大授权。

另外用临时 0700 Home 的两库一致性副本执行 **N2 → 已安装旧 Dev 后端 54a117c9 → N2**，不复制 secrets/provider 配置。旧版执行 flags 仍为 false；新表完整行不变。再升级后自然偏好 v3 和来源/变更仍相同，两库完整性正常；真实 Dev 未受影响。此验证不声称旧版理解新 API/新队列，也不以旧数据库覆盖真实运行记录。

## 剩余边界

- N2 只自动形成一项明确长期表达/报告偏好；批量语义合并、冲突整理、水位和完整预算等待留待 N3，压缩补提取留待 N4。
- 新自然偏好尚不注入普通对话、Pilot 或工作流；完整召回、独立停止使用及统一入口在 N5 验收。原项目记忆/已采用资产继续走原路径；不能将同会话上下文表现当作新召回收益。
- 单个模型的固定集合通过，不代表所有模型、所有语言或对抗输入无误。更晚修改/来源变化保守拒绝，不能为了召回率覆盖用户新内容。
- 运维 V2 门控仍为 false；Windows 只有交叉编译，未执行原生 UI、安装包或额外 CI；无生产发布操作。
