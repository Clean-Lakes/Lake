# 普通会话长任务持续跟进验收

日期：2026-10-29。实现分支 `codex/long-task-continuity-plan`，PR #120，目标 develop。此次仅实现与安装 Lake Dev，不操作原会话中的真实发布、数据库或生产应用。

## 已验证的行为

- 公开 ADK long-running function tool 与 Workflow machine input 等待/恢复；等待不进行模型轮询，原 function-response ID 保留，独立新话题可完成。
- Shell 原任务只派发一次；真实完成后在原目标接续并带名汇报。关闭/重开存储使用当前模型配置和原命令记录，新话题 RootTurnID 与状态不被覆盖，outbox 重投不重复展示结果。
- 六项独立发布/构建观察可完成；用户接管的数据库项保持 waiting_user，依赖部署保持 pending，独立结果仍能汇报。
- 宿主工作 ID、依赖环校验、跨会话控制拒绝、revision CAS、过期租约拒绝、五次传输失败、deadline、取消正在观察的请求、迟到结果与会话删除。
- 无效 work_finish 不输出假完成，也不终止原官方模型流程。已完成操作不能换 call ID 重放；未满足依赖不能选为执行项。
- 发布观察仅接受显式本机配置的 release-v1 能力、原服务版本和原任务 ID，导入配置不得建立该能力；能力检查与配置失效检查不会连接远端服务。
- 三次压缩保留目标和真实人类答案；自动摘要失败/子期限可用活父 context 继续安全预览，父取消不被吞掉。原有压缩和后台终端回归保留。

## 命令及证据

实现源码提交：`b78269f0211da1f8cb743e4f717e5ac7e1e338ea`。最终文档记录提交不改变运行源码；最终检查及安装 head 在 PR #120 核对。

| 检查 | 当前结果 |
| --- | --- |
| 新增目标、等待、恢复、生命周期及拒绝假完成测试 | 通过 |
| Web 可信能力、MCP 配置与原有后台 PTY 三项集成 | 通过 |
| `test:frontend` | 555/555 通过 |
| `build:web` | 类型检查及构建通过；既有大 chunk 提示 |
| `check_adk_runtime_boundary.py` | 通过 |
| 工作区 `go test ./...` | 仅本地 ignored output_recovery_test.go 的已有失败；详见下方 |
| 工作区 ai/web race | web 通过；ai 仅同一 ignored 基线失败；无 DATA RACE |
| 最终提交源码全量、race、vet | 全部通过：AI race 171s、Web race 527s；无 DATA RACE |
| 签名 Lake Dev 构建与安装 | 使用官方 Dev 脚本；最终安装来源及结果对照 PR #120 和应用内 build-origin.json |

工作区存在被 `.gitignore` 的 `internal/ai/output_recovery_test.go`，未包含在仓库源码中。其 `TestOutputLimitRetryUsesCompletedHistoryAndNeverRunsTruncatedCalls` 在当前工作区失败，也已在干净 `origin/develop`（360fc7d7）的归档副本加入同一文件独立复现。没有删除、修改或跳过该本地测试。最终源码验证使用提交归档运行所有受版本控制测试，与该本地基线分别报告。策略目录快照仅更新普通 core 的新工具哈希，基础 prompt 哈希与 workflow/角色范围不变。

## 界面与环境

通过 ego-browser 运行真实 App fixture（虚构快照与 API），验证浅/深色、三联目标宽度无溢出、详情入口和键盘暂停/继续/停止；后台等待仍能输入新消息，旧目标不覆盖新话题状态。截图保存在本机 `/tmp/lake-work-light.png`、`/tmp/lake-work-triple-dark.png`。没有调用实际外部工具。

800px 截图仍有既有终端抽屉遮挡；虽检查了减少动态效果配置，不能声称窄窗口目标面板完成视觉验收。原生 CUA 连接 Lake Dev 返回 timeoutReached，未宣称原生逐项交互验收通过。签名安装来源在 Dev 应用的 build-origin.json 记录，最终检查同步 PR #120。运行中的 Dev 进程保留，重新打开应用后加载安装的新版本。

签名 `bin/lake` 已在全新私有 Home、随机 loopback 端口和虚构模型服务下完成真实 HTTP/PTY 重启验收：后台命令等待时退出后端并重开，新话题完成后原目标按原记录接续；原目标 3 次加新话题 1 次模型请求，原命令派发 1 次，命名结果一次，新话题身份不变。另有 2 次现有自动命名请求，不属于工作目标轮询。最初验收脚本把命名请求误算为主模型请求，修正统计后重跑通过；未放宽功能断言。此次未使用 Dev 或生产已有凭据。

## 边界及回退

观察器当前串行执行；仅支持可核对原句柄的 Shell 与显式配置的 release-v1。没有恢复句柄的旧本机进程、后台接续中途崩溃以及新审批/问题需要人类核对；不会重放变更或伪造答案。等待用户的依赖需通过真实后续请求和原记录处理。全部断电窗口、虚拟十分钟、系统休眠/时钟偏移、所有错误排列及 Windows 原生尚未穷举，不作为已通过项目。

新增私有领域表不删除既有操作/审批数据；不升级 SDK。回退前暂停/停止所有新工作目标，保留最新 sessions.sqlite 与原操作记录，使用兼容该附加结构的签名构建；不能恢复旧数据库来覆盖已经派发的操作。本次不合并或发布生产版本。

最终 race 期间发现并修复了检查点浅拷贝与 Shell 卡片更新竞争，以及并发 outbox SDK 投递竞争。检查点现在在会话锁内序列化，tick 与 outbox 分别串行化；三轮新增用例 race 已通过。同一目标连续等待构建/部署使用各自原 call ID 的独立公开 Workflow checkpoint，已增加回归。

空闲观察在 nextCheckAt 到期前不重新加载或保存会话配置；新增回归校验目标 revision 不变，避免等待时每秒刷新前台。

可复跑的签名程序验收（使用临时 Home 与虚构模型，不影响正在运行的 Lake Dev）：

```sh
python3 scripts/verify_long_task_continuity_dev.py --binary bin/lake
```

该脚本在 macOS 首先验证二进制签名，等待实际后台执行占用已释放再退出后端；每次等待保留原调用身份。成功后清理自己的临时 Home。也可用 `--binary "$HOME/Applications/Lake Dev.app/Contents/Resources/lake"` 检查已安装的签名后端。

最终提交源码由 `git archive` 导出，并补入本次成功构建的 Web 静态产物（Go embed 必需输入）后运行完整 Go/race/vet，未省略受版本控制的测试。运行代码对应 b78269f0；后续文档与复跑脚本提交不改变 Go/React 运行源码。工作区其他未跟踪文档保留，因此构建来源的 dirty 标志可为 true；安装前确认所有受版本控制的运行源码无未提交差异。

后续增量“待发送消息推送为本轮补充”的实现与验收另见 [queued-message-supplements.md](queued-message-supplements.md)；本文件此前的源码及安装 SHA 描述长任务基线，不代表该增量尚未实现。
