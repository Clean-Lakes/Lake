# 独立只读复查的回执读取与调用恢复

功能及签名 Lake Dev 提交：`7098f25d0c858f7ae7f7d9303ecebc50d7cf1b1c`。安装 `build-origin.json` 为该提交、`dirty=false`、`backendRuntime=typescript`。后端 SHA-256 为 `d70fd6cc37765e8464e4064de633b44c949bd61ee6a0ec7c7324e33d3092d97e`。

## 实际故障

截图对应 `st_f3b6fdfe946e9c2d3abfe8f3f00f0ec1` 的第一代执行。此前的 3 笔宿主只读调用成功；包含 `systemd-detect-virt` 的日志查询链因该程序未被识别而拒绝。随后模型用未绑定远端资源的本机 Python 读取 SDK 截断产物，原项目策略不允许该本机资源。该预检异常出现在 SDK 权限能力解析阶段，结束整轮，报告只留下通用错误。

本批没有修改该项目策略，也没有开放 Python、产物目录或本机执行。

## 变更

- `read_tool_output` 按准确调用 ID 分页读取当前任务、执行代次与子执行归属下的原 Operation 输出；读取前重验 Worker、策略、目标范围、来源权限和输出哈希。不接收文件路径，不创建命令或另一份业务证据。后台未结算调用继续使用原 TaskOutput 句柄。
- 原生 Bash 保留 SDK 校验，增加宿主预检的可恢复失败结果。资源选择、准确配置与只读范围错误回到模型，正常权限解析和 I/O 前再次校验；不会把拒绝变为批准。
- 虚拟化检测只允许准确的查询参数及系统路径；动态脚本、未知选项和写入仍不能证明只读。截图中的完整日志查询链有专门回归。
- 提示词说明长回执入口与错误纠正；已知宿主资源错误提供具体说明，未知错误仍保留通用退路，避免暴露任意异常载荷。

## 自动验证

固定 Node 24.14.0，测试使用临时 Home、合成凭据、受控供应商及 loopback SSH，不访问真实业务服务器。

| 检查 | 结果 |
| --- | --- |
| runtime TS 类型检查与 bundle | 通过 |
| TS 源码全套 | 247 项：243 通过，4 个原条件跳过（可选 Claude-Mem/Linux 专属扫描） |
| 生命周期定向复测 | 62 项通过，包括最后补充的只读复查预检断言 |
| 打包后 SDK 全套 | 182 项全部通过 |
| 共享命令策略测试 | 47 项通过 |
| Web 类型检查 | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `scripts/build_lake_desktop.sh --dev --install` | macOS arm64 签名构建安装通过 |
| `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app` | 通过 |

真实 SDK 回归先故意请求不允许的本机命令，再执行唯一一笔绑定 SSH 的只读调用，生成超过 60 KiB 的回执，确认模型收到 SDK 截断结果后从 `read_tool_output` 读到尾部标记，并通过 `work_finish` 提交。本机未执行命令，没有额外审批；只有一笔 SSH CommandRecord/Operation，读取页没有增加业务证据。

归属测试拒绝其他 Task、Session、Project、代次、策略快照及 child；准确 child 可读自己的原调用 ID，父执行不能借该 ID 读取。篡改输出、来源撤权、未结算和非法分页均拒绝。

本批没有修改 React、Swift 或样式，不把未重跑的整个 Web 测试套件算入新增验证。完整桌面构建重新编译了 Web。

## 原生 Dev 与实际服务器复测

先确认 Dev 没有 active/queued Worker，再通过原生菜单“停止内核并退出”安装，启动 `~/Applications/Lake Dev.app`。Bundle ID 为 `com.cleanlakes.lake.desktop.dev`，Home 为 `~/.lake-dev`；生产应用与数据未改动。

在原专员频道提交标有“修复复测”的明确只读续查要求，沿用同一任务与原服务器范围：

- Task：`st_f3b6fdfe946e9c2d3abfe8f3f00f0ec1`，Worker 第二代，root `turn_e69670fa-5b43-4684-bde1-3925381bf73b`。
- 唯一目标：`eca87dce9daaad6ef2fbbba90b1e8b99`，原截止时间 `2026-11-10T01:47:48.394Z` 保持。
- 模型先两次尝试读取第一代调用 ID，均被正确拒绝。这两笔真实失败保留，没有伪装成成功。模型随后自行重采，本轮 3 笔 Bash 全部 `succeeded/readOnly=true`，均绑定原 SSH 资源；包含实际 `journalctl` 和 `systemd-detect-virt` 查询。
- 本轮 SDK 状态 completed，任务 completed/pass。原生专员频道实时显示本轮总结，旧失败收进“之前的 1 次执行”。没有再次出现通用整轮错误。
- 总结确认启动约在 11 月 8 日 17:12，上一轮日志末尾为 17:10:23，末尾没有正常关机流程，相关内核警告及错误查询为空，检测为 KVM。**这些客户机观测不足以证明重启根因**，总结明确建议检查虚拟化平台的宿主机/虚拟机事件。

原任务 `st_39bbd8864757f39c01831e28eba96189` 的 Goal、Worker、Operation、Attempt 与 memoryReads 共 7 条原始记录，在安装及实际续查前后逐条 SHA-256 不变。比较清单摘要 `47f3b7c9e4ff524693c8fc8d1f9852587e9021784a43476d35cdc4a5bdf5c99a`；原 unknown 与记忆依赖保持，复查完成不结清原操作。

## 限制与回退

真实服务器本次未产生需要分页的新长回执，分页成功由受控 SDK/loopback SSH 验证；真实模型验证的是旧代读取被拒后自行重采恢复。不能据此承诺任意模型总能选对工具，或服务器重启原因已查明。Windows 和可选 Claude-Mem 本次未验证。

回退宿主工具、预检、准确命令分类及提示词；不清理原账本或复活旧上下文。本批不包含合并或正式发布。
