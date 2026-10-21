# 策略学习 P3 本地验证

2026-10-21，基于 P2 PR #39 已合入的 `origin/develop`（`f2a9688a2040d6602f985e6d85309fa5e78e548c`），分支 `codex/strategy-learning-p3`，PR 目标 develop。范围见[设计说明](../design/strategy-learning-assets-v1.md)。

最终实现及签名 Dev 的已测试 SHA：`3b9a31a6cc51d6208e04ec7a820a62e2d3bc6271`。最终验证记录提交只更新文档，不改变运行代码；发布前仍需对合入 develop 的集成 SHA 验收。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| `go test ./...` | 通过；最终 web 135.487s，覆盖所有最终 Go 代码 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy` | 通过；最终 ai 128.941s、web 284.355s、strategy 1.764s，覆盖最终宿主异常/凭据变化防护 |
| `go test -race ./internal/strategy ./internal/ai ./internal/web -run 'TestStrategy\|TestPrompt' -count=1` | 通过；解析器、实际请求、宿主 API、Skill 变更/读取权限及源撤权等定向验证 |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过；ADK 仍为唯一循环 |
| `corepack pnpm check`（web-agent 目录） | 通过 |
| `corepack pnpm test:frontend`（同目录） | 340/340 通过 |
| `corepack pnpm build:web`（同目录） | 通过；保留既有大 bundle 提示，不改阈值掩盖 |
| `git diff --check` | 通过 |

原始命令日志在本机 `/tmp/lake-p3-*.log`，没有提交生成包、凭据或运行数据库。develop PR 按规则无自动 CI，未手动触发 CI。

核心行为由断言验证：

- 默认关闭；采用后仍需开关；未采用的新修订不替换 v1；项目关闭可限制全局开启。通过 loopback 模拟 provider 捕获实际 system 请求，未访问真实模型。
- 精确版本/hash、稳定排序、互斥组排除、选择器、不重复正文、JSON 转义后的预算裁剪、实际 manifest 的 selected/omitted、无原文/秘密清单。
- 撤权发生在模型结果与工具之间时，工具未执行、没有第二次模型派发；运行中关闭总开关会取消原请求，不重放操作。
- HTTP 同源/认证、跨项目 404、CAS、同 key 重放、异内容冲突、未知字段/大小写别名/重复 key/null/尾随文档/分页与完整 budget。
- 已登记 Skill 原文快照、读取权限限制、源修改后停止；缺失宿主 session 返回安全错误；历史正文后来与配置凭据重合时拒绝注入，错误不回显秘密。
- P1 关闭态黄金样例及原有 Go/前端回归继续通过。

## 签名 Dev 与真实桌面

使用 `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake_desktop.sh --dev --install`，基于已完成的前端构建。最终包安装到 `~/Applications/Lake Dev.app`，build-origin 记录上述 SHA、dirty=false；`codesign --verify --deep --strict` 通过，安装包后端 SHA-256 与 `bin/lake` 一致。

原生桌面交互在 `28215b16aae3e33737a6c0ff5cb36d578f0fb305` 完成；最后的 `3b9a31a` 仅补 Go 宿主异常/凭据变化保护，前端与原生代码相同，重新完成全量 Go/竞态、签名安装及同 Home 的最终签名后端重启复核。

在 macOS arm64 启动独立临时 Home `lake-p3-ui-*`，只有本次合成项目/偏好/Skill，无模型配置、无远程资源；未使用生产 Home 或拷贝生产凭据。桌面操作观察到：

1. 设置 → 策略资产默认全部关闭；学习/纠错标记为后续交付且不可操作。修复并复测“无会话项目默认全局”的入口问题，现在取侧栏当前项目。
2. 手写并保存 v1，明确采用；保存 v2 后仍采用 v1；采用 v2，再通过共享 AppSelect 的 End/Enter 选择 v1，回滚后绑定递增至 3；停用后为 4。来源/父版本差异及回滚关系可见，最终界面关系为中文。
3. JSON 经原生 NSSavePanel 保存至独立临时目录，读取落地文件验证格式及正文。通过 NSOpenPanel 再导入当前项目，仅载入待确认正文，保存后为新的 v1、未采用，不继承全局身份/采用状态。
4. 项目打开总开关及应用后，全局仍关闭，界面真实显示实际应用关闭；无静默开启学习/纠错。
5. 从登记的 `p3-evidence` 导入独立 Skill 资产，显示原文 hash 与源一致。显式更新源文件后重新打开资产，正文/hash 不变，显示源变化及停止应用提示。导出 SKILL.md 后核对落地文件仍为原快照。
6. 深色、浅色、约 850px 的窄桌面窗口及纵向滚动可用；版本/Skill 共享选择框键盘可用。验收后恢复原浅色与窗口大小，正常退出隔离 Dev。

首次在运行中的 Dev 被安装替换后，打开原生保存面板遇到一次 AppKit/WebKit completion 异常。退出并清理本次隔离 Home 的孤儿后端、重新启动完整安装包后，JSON 和 Skill 保存均成功；最终构建验收期间未再次替换运行包。此过程未强制停止用户的正式应用或业务任务。

桌面退出后，用签名 `bin/lake` 在同一隔离 Home 重启复核：全局资产 2 版、项目资产 2 个、停用绑定版本 4、血缘分页 7 条边含回滚、Skill 源变化但快照不变、两个落地导出文件及实际应用关闭均通过。结果存于本机 `/tmp/lake-p3-signed-smoke.json`；进程已正常停止。

## 边界及回退

P3 只交付 M1。没有自动学习、纠错 worker、实验对比或生产故障采样；没有真实模型/故障夹具评估，也没有效果、耗时或成本提升结论。普通 Web/Desktop 主会话支持；隔离角色/工作流与 CLI 不注入，领域标签暂未提供会话入口。Windows 原生窗口和浏览器移动端未做实机验收。

不改变冻结的 P2 schema。先关闭总开关，再经 PR 回退到 P2，可保留资产/来源记录；P2 以前的二进制仍须使用隔离兼容副本，不得覆盖后续业务与 ADK 操作账本。旧外部操作的结果不因关闭策略被宣称回滚。
