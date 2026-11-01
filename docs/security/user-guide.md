# Lake Security 使用与维护

本说明对应任务闭环后端实现。正式发布及实际启用状态以发布说明和管理接口为准。本轮沿用现有提问、操作审批、工作项和执行记录，不增加前端组件；SOP 清单另按独立计划交付。

## 任务与授权

先确认目标、步骤和验收条件，再确认资源操作范围。确认计划不产生操作权限。支持任务授权的动作可选择“本任务范围内自动执行”，最终仍须审核原生操作审批中显示的资源、命令模板、参数范围、次数与绝对到期时间。

范围内后续动作自动执行；范围外、次数耗尽或连接变化时重新确认。授权不能覆盖项目/父范围/本机的明确禁止。续接、重试和暂停不自动补充次数或延长到期；目标契约变化使旧任务授权失效，需要明确重新授权。

任意 Shell、原始 SQL、opaque MCP 和不受控交互不获得任务通配授权。compatible 模式下明确批准的任意 Shell 仍使用当前操作系统账号权限，Go 审批不是 OS 沙箱。固定磁盘/进程/服务状态/日志命令和登记服务的重启通过受控模板执行；服务名、OS、模板版本与参数由宿主注册，不能靠命令前缀放行。

Lake 自己的 Home、runtime、控制面、数据库及凭据目录不接受普通文件授权；用户选择宽目录也不能开放这些文件。正常凭据仍由执行适配器按 reference 读取。

## 完成与失败

执行成功和业务验收分开记录。自动验收需要受控探针的真实证据；不支持的业务验证采用明确人工验收，不能让模型输出充当用户核验。

失败尝试保留原状态。替代路径成功后，须关联原步骤和等价覆盖；unknown、取消未确认、失联及部分副作用先保留并核实。停止请求、终端断开或本地 SSH 退出不证明远端操作停止。新任务成功不会清除旧任务风险。

## 管理接口

管理接口使用当前本机宿主认证、项目/会话归属、`actionId` 和相应 revision CAS；服务端决定 actor。目标选择和边界修改彼此独立。不要将这些 API 暴露为模型工具。

| 用途 | 入口 |
| --- | --- |
| 项目策略 | `/api/projects/:projectId/security/policy` |
| 服务/OS 命令注册 | `/api/projects/:projectId/security/command-targets/:resourceId` |
| 任务与授权 | `/api/sessions/:sessionId/security-tasks` 及任务 grant/revoke 管理子路由 |
| 原目标契约、验收、覆盖 | `/api/sessions/:sessionId/security-work/:goalId/{contract,verify-step,verify-human,verify-goal,coverage}` |
| 工作流验收契约 | `/api/projects/:projectId/security/workflows/:workflowId` |
| 当前目标 | `/api/sessions/:sessionId/target` |
| 旧空目录范围确认 | `/api/sessions/:sessionId/security-migration/resolve` |
| 七项旧权限显式管理 | `/api/sessions/:sessionId/security/legacy-policy` |
| 分页审计 | `/api/security/audit` 或项目 security/audit |
| 全局模式和准备摘要 | `/api/security/mode` |

先读当前 revision/摘要，再提交明确动作。普通设置同步不会覆盖已确认的策略或授权；重复 action 必须是相同内容。人工验收还要绑定当前会话内原始用户消息和全部条件 ID，不能用系统消息或另一会话代替。

## 启用与恢复

普通模式管理通过当前运行的本机宿主及其私有 runtime 认证，不打开第二个 Home owner：

```sh
bin/lake security mode --home /absolute/isolated/home
bin/lake security shadow --home /absolute/isolated/home --input /private/action.json
bin/lake security enforce --home /absolute/isolated/home --input /private/action.json
```

动作文件须为私有普通文件，包含 `actionId`、`expectedRevision` 和先前读取的 `confirmedDigest`。全局 enforce 还要求编译时入口覆盖、项目策略、旧范围和历史风险检查通过；不能用请求字段强制开启，也不允许降回旧模式绕过限制。shadow 不采用新的 allow 结果替代原执行权限；真实托管操作在准备后纯比较旧 allow/approval_required/deny 与新结果，缺少可信任务或目标/终端元信息则明确记为 incomplete，不编造允许。管理状态的 `shadowDifferences` 展示差异；未经确认的 widening 阻止启用。先以原摘要、CAS、`actionId` 和精确 `confirmedShadowDifferences` 事件 ID 提交 shadow 确认，读取新的 READY 摘要后再单独 enforce；ACK 本身不授予资源操作权限。

已启用全局 enforce 的 Home 中，新项目使用默认 restricted 策略；受控本机命令可以申请明确任务授权，已有 deny 不会被覆盖。缺少策略的项目或无项目身份不得退回 legacy。

备份和恢复使用[成对 checkpoint 协议](checkpoint-and-recovery.md)。先停止对应 Home 的宿主，再生成并核实配对快照；恢复会推进随机 epoch、撤销旧授权、暂停旧任务、禁用定时任务并关闭 gate。逐项确认策略、旧权限、真实连接和影响范围后才可开闸；不明范围保持管理阻断。

恢复 Memory 需要 Memory 提供者独立核实同意与遗忘下限；任务授权或恢复资产策略不能代替它。定时任务使用独立的[有界 schedule 授权](schedule-authority.md)，禁用仅停止未来触发；撤销授权或改变模板/目标会使相应执行资格失效。

不要删除 control、操作、审批、风险或恢复清单来解锁。回退必须使用理解当前 reader guard/epoch 的兼容二进制及受控恢复流程；旧版本不能直接读取新权威状态。

## stdio 宿主对接

`lake ai --home /absolute/isolated/home` 使用与 Web 相同的规范库和唯一 owner；先正常关闭该 Home 的 Web，再启动 stdio。`configure` 帧在协议顶层提供 `hostProjectId`，会话必须确属这个项目。宿主从真实存储读取资源、连接、凭据目录和已确认的七项权限；不要在模型配置中自行构造这些权威。managed bridge 由实际本机宿主执行，不接受外部 callback 的 approved 字段代替许可。

Memory 的恢复资格由 Memory 提供者独立确认；尚未提供所需同意/遗忘核实能力的集成继续保持关闭，不以项目策略或任务授权解锁。
