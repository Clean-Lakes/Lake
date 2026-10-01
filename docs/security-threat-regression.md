# Lake 迁移安全回归

本清单对应 [迁移方案](../plan/architecture-zcode-lake-1.md) 的 TASK-033。测试使用合成凭据标记、假 SSH 和本机 HTTP/MCP 服务；不会连接用户的真实资源。

| 场景 | 断言与回归测试 |
| --- | --- |
| MCP 凭据与不安全地址 | stdio 只继承最小环境，HTTP 凭据只进传输层；拒绝内网 HTTP、URL 用户信息及查询参数，连接失败不回显凭据。`lake/extension/mcp/client_test.go` |
| Hook 路径逃逸、变更、超时、输出过大 | 拒绝目录外命令与符号链接；声明或文件变化使许可失效；取消会中止命令，输出各限制 8 KiB 并标记截断。`lake/extension/hooks/runner_test.go` |
| Web 地址逃逸、页面注入、超限 | 域名白名单、地址解析和跳转限制生效；脚本内容不进入纯文本页面；外部页面标记 `untrusted`，网络错误不回显查询内容；超限拒绝。`lake/agent/tools/web_test.go`、`browser_test.go` |
| 远程代码工作区越权、路径逃逸、断线 | 授权与主机执行授权独立；敏感路径和越界路径拒绝；读写限定根目录及大小，写入带旧 SHA；断线结果为 `unknown`，无自动重放、无虚构退出码，湖志只存参数摘要。`lake/code/remote/*_test.go`、`lake/store/code_workspace_test.go` |
| 工作流未知写、结果引用、审批 | 写节点中断转 `unknown`，恢复要求显式重试；只读取已提交节点结果；无批准保持 `waiting_approval`，事件能解释状态。`lake/workflow/engine_v2_test.go` |
| 调度重复认领、授权变更 | 同一到期点只能认领一次；租约到期暂停并标记未知；授权绑定版本、节点、资源和命令哈希，资源撤权后不能消耗。`lake/store/schedule_test.go` |
| 工具与事件输出 | 注册表拒绝未授权或超出 scope 的工具、裁剪输出；持久事件白名单拒绝未知字段和超限内容，敏感预览脱敏。`lake/agent/tools/registry_test.go`、`lake/store/agent_event_test.go` |

新增四项闭环回归：`cmd/lake/migration_closure_test.go` 验证插件 MCP 停用撤销、Hook 拒绝与摘要失效、自定义专员独立模型/白名单与范围、结构化 v2 桥审批；`lake/agent/specialist/checkpoint_test.go` 验证重启复用完成结果、未知写显式重试、并发锁及符号链接拒绝。`lake/store/migration_v17_test.go` 验证早期缺列库升级保留历史会话并创建私有备份。

本地 Shell、远端任意命令和 Hook 在用户明确批准后仍能访问其操作系统账户允许的内容；Lake 的边界是范围校验、逐次审批和执行服务复核，不是操作系统沙箱。真实 SSH 断线、真实模型提示注入效果和生产 MCP 服务可用性仍需在目标环境做人工验收。失败的远端写入须先只读核对，再由用户决定是否重试。
