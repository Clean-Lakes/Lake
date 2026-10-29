# Lake Memory N5 验收

日期：2026-10-29。平台 macOS arm64 与 Windows amd64。保持实验；不涉及生产、Release 或安装包发布。

## 基线与版本

已按用户明确授权检查并合并 [PR #114](https://github.com/Clean-Lakes/Lake/pull/114)，核对原 head `f13b0b85` 与 squash 树一致，清理远端/本地工作分支。补跑 `TestMemoryCapture`：AI 1.514s、Web 1.567s 通过。N5 从最新 `develop@87cd9ea84eca1e7139820473f82212389842ae88` 独立开发，仍以 develop 为 PR 目标。

最终本地全量验证与签名 Dev 来源为 **`7c82f95601585a252ec5200e8b31f9996d5107d1`**，dirty=false；后续仅补文档/证据和旧 Windows 兼容 UI 测试的入口选择器。最终跨会话冒烟在该 Dev 完成。完整场景初次运行于 `fdb60dee`，Pilot/遗忘修复后运行于 `39eb8570`，Windows 分项版本见下表；不将较早结果冒充最终源码的重测。

## 本地检查

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1 -timeout=8m` | 全部通过；AI 52.165s、Web 192.684s，见[检查记录](natural-memory-n5/checks.json) |
| `go test -race ./internal/ai ./internal/web -run 'Test(Natural\|Memory\|ProjectMemory\|Strategy\|Compaction\|ModelSwitch\|ADKOfficialProjection)' -count=1 -timeout=6m` | 通过；AI 19.929s，Web 73.900s |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过；没有新增模型/工具循环或 SDK 内部依赖 |
| web-agent 下 `corepack pnpm check && corepack pnpm test:frontend` | 类型检查通过，543 通过、0 失败/跳过 |
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/lake-n5-delivery-windows.exe ./cmd/lake` | 通过 |
| `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/lake-n5-client-tests.exe ./client/windows` | 新旧 WebView2 测试交叉编译通过；不是旧 P8 UI 的新原生实测 |
| `scripts/run_lake_dev.sh` 与 `codesign --verify --strict bin/lake` | 新 Web 构建、签名及来源/hash 对照通过；不制作 ZIP/DMG |

新增 8 个 AI、6 个 Web 回归及一个 Windows WebView2 测试。覆盖准确请求/manifest、原固定规则、当前请求提示优先级、在途撤回前阻止工具副作用、可选服务故障、输入/引用预算、隔离入口、原文只在请求内交付、持久回执无正文、重启忽略标记/已用引用、准确版本、项目/全局优先级、跨项目拒绝、冲突、遗忘/来源删除、全局隐私、独立设置/CAS、迁移保真/future guard。JSON 编码后的旧资产正文也去重；第 33 个未受保护引用不能进入上下文。

原 C1、审批、取消、unknown、项目记忆 V1/V2 和官方运行回归包含在全量检查中。V2 仍关闭。旧 SQL/schema/hash、分类器提示和解析契约未修改；新增 recall 独立元数据与设置表。

## Windows 授权分项验证

用户授权“一次 Windows CI；失败仅重跑失败项”。使用 N5 专用手动入口，没有安装包或发布步骤；既有普通 push/develop CI 规则不变。按实际失败缩小后续范围，没有重跑已通过的前端/AI/其他 Web 项。

| 运行与源码 | 范围与结果 |
| --- | --- |
| [40801596960](https://github.com/Clean-Lakes/Lake/actions/runs/40801596960)，fdb60dee | 前端类型、543 测试和构建通过；资源复制因目标目录未创建失败，后端及原生 UI 未运行 |
| [40802269014](https://github.com/Clean-Lakes/Lake/actions/runs/40802269014)，39eb8570 | 跳过已通过前端检查，补资源复制；AI 37.167s 通过，Web 仅四个迁移权限断言失败；原生 UI 尚未运行 |
| [40803070689](https://github.com/Clean-Lakes/Lake/actions/runs/40803070689)，64b518f8 | 只重跑四个失败迁移测试及未完成 WebView2，全部通过；无需重跑其他已通过后端项 |

四个失败断言把 POSIX `0600` 当作 Windows 文件隐私判据，现改为已有 `platform.Private`：Unix 验证所有者/权限位，Windows 检查实际所有者及 DACL，没有删测试或放宽权限。新增迁移用例在断言前关闭数据库，失败时也不遗留锁。

真实 Windows WebView2 使用空隔离 Home、实际 React/Go API、无模型：默认使用/积累均关闭；仅切换使用不改变自动同意；停用持久保存；旧管理默认折叠；深色、834×561 viewport、范围下拉 Escape 和面板无横向溢出通过。原始 artifact 已保存为 [windows-ui.json](natural-memory-n5/windows-ui.json)。本次没有重跑旧 P8 策略确认原生 UI；其测试已改从“记忆 → 历史资产与兼容管理”进入，后续生产提升仍会执行原完整 Windows 工作流。

Windows 通过的版本之后还有平台无关的 JSON 正文去重修复，已在最终 macOS 全量/race、独立回归和 Windows 交叉编译验证；不宣称原生 CI 覆盖了这个后续提交。

## 真实模型和 Dev

固定 `~/.lake-dev`，使用已配置 `deepseek-flash`，没有修改/复制供应商密钥。新建两个虚构项目，原项目记忆使用/提炼关闭；原有其他项目、用户消息和正式版 `~/.lake` 未修改。升级前对两个数据库以 SQLite backup API 建立私有一致性备份；首次 N5 启动在发送新样本前，49 个原策略/自然记忆表的行内容 hash 一致，没有继承使用同意。

[结构化 Dev 记录](natural-memory-n5/dev-scenarios.json)：

| 场景 | 结果 |
| --- | --- |
| 项目/全局分别形成“【项目偏好】”“【全局偏好】”开头约定；独立开启使用 | 新会话读取准确范围，无需逐条采用 |
| 项目 A 回复三次，均为独立新会话 | 3/3 使用项目前缀；准备记录只有 project |
| 项目 B 回复三次，均为独立新会话 | 3/3 只用用户全局前缀，未读取 A 项目偏好 |
| 项目 A 明确要求“只回复数字4”三次 | 3/3 仅输出 4，当前要求覆盖已准备的偏好 |
| 使用停用、单轮 ignore、遗忘项目偏好 | 三项通过：无准备记录/不读被遗忘 ID；独立全局偏好仍按自身选择可用 |
| Pilot 协调层，三个独立新会话 | 3/3 使用项目表达前缀；无 SRE 任务、专员或资源操作；结束后恢复该测试项目 Pilot 关闭 |
| 最终 7c82f956 的两个新会话冒烟 | 跨会话前缀及当轮覆盖通过；两库 integrity_check=ok，签名及来源 hash 相符 |

初次 12 项与修复后的 3 项 Pilot 共 15 项全部通过，最终另补 2 项冒烟，[最终画面](natural-memory-n5/cross-session.jpg)。前 15 项主轮次已报告 239,182 tokens（输入238,331/输出851）；四次后台记忆派发共 7,307 tokens，其中一次保守阻断，不能当作四次成功写入。最终冒烟用量另列 JSON。未把主对话、正常工具续轮或摘要费用混成零检索成本。

另显式重跑原 [60 个冻结意图样本](../../internal/web/testdata/natural-memory-intent-v1.json) ×3，180 次原无工具 completion、真实临时 Store 提交：每轮长期正向 30/30、误写0、错误范围0、技术失败0；精确决策均55/60。输入284,608/输出34,420 tokens。实际模型与逐例结果见 [model-intent.json](natural-memory-n5/model-intent.json)。该评测在 fdb60dee 执行，不是所有模型或运维事实质量证明；没有改变样本 SHA 或判据。

macOS 原生窗口实际点击访问记录进入统一记忆、关闭/恢复使用、下拉 Escape、浅/深色、滚动和旧管理默认折叠；[浅色](natural-memory-n5/light.jpg)、[深色](natural-memory-n5/dark.jpg)。macOS 窄窗口尺寸本次未测量，窄 viewport 使用上面的 Windows 实测，不能把两者混记。

## 发现的问题、升级与边界

- 遗忘后新真实消息试图重新建立同主题偏好，初次被旧 `consolidation_conflict` 保守阻断，没有错误写入。修复仅允许 inactive 目标上的新来源形成新版本，旧来源/墓碑/时间检查仍生效；相同 topic 的精确恢复由回归验证，随后真实新消息也成功形成偏好，不把模型生成的不同 topic 当成同主题恢复的证明。
- 引用上限达到 32 后拒绝新读取，避免把不能继续重验的内容交给模型；JSON 编码的旧正文也只保留一份。两者均有回归。
- 隔离数据库副本执行 N5 → 已安装旧 Dev54a117c9 → N5，只启动/读取设置、不执行任务或模型请求；自然表行内容和两个偏好条目一致，两库完整性 ok，未复制密钥。该窄范围兼容不承诺任意旧版本或旧版活动任务写入；回退需先停 Dev，使用一致性备份，不能覆盖用户最新工作库或操作账本。
- 原始消息和模型已生成回复仍为历史对话，遗忘资产不批量删除对话。新的请求附件/工具正文没有写入持久 system、工具回执或摘要来源；当前活动选择始终以实时检查为准。
- 新使用默认关闭，功能仍为实验。全局测试开关已恢复原来的关闭值，仅虚构测试项目保留使用开启、自动积累关闭；其演示偏好可继续试用。初次失败的后台记录保留为暂缓，不标成已处理。
- 当前只开放表达偏好；资源事实/历史经验继续原项目记忆及 V2 门控。专员/工作流不继承新偏好，手写 Skill 和复杂条件旧资产仍保真兼容。C3/C4 剩余依赖与清理未完成。
- 实测支持这个模型和虚构范围/表达样本，不证明复杂业务收益、所有同义 topic 的冲突识别或通用运维经验复用。历史 P8 的 inconclusive 结论未改写。
