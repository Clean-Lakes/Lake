# Lake 执行入口与执行保护

基础清单始于 develop `be656805d345466f11bbb9c2c4af92e670da7420`，本轮在同一清单上完成任务闭环。工具名和分类见 [JSON 清单](tool-entrypoints.json)，纯领域注册见 `internal/security/capability.go`。`TestSecurityEntrypointInventory` 对照真实目录；`security_enforcement_coverage.go` 静态列出 **93 个工具 + 13 类入口 = 106 项**，新增或退役入口会使精确覆盖检查失败。

覆盖表示入口接受统一保护，不能据此认为所有操作都有受限执行适配器。不支持的复合动作会明确拒绝；无法证明的动作保持 opaque，restricted 拒绝，compatible 仅可精确单次审批。实际验证和限制见[实施记录](../validation/lake-security-task-closure.md)。

## 入口与权威归属

| 入口 | 身份与执行保护 | 原账本和生命周期 |
| --- | --- | --- |
| `Engine.invoke` / `@invoke` | 配置项目统一 Prepare；真正 I/O 前重新校验 gate、epoch、任务、当前连接与权限 | 原 native operation、approval、evidence；登记、扣次数及审批消费同一事务 |
| Web / `@web_bridge` | 原鉴权和会话归属；桥接还必须持有进程内许可，外部 approved 布尔无放行能力 | 当前真实资源配置经 catalog changing/ready 协议冻结 |
| stdio / `@stdio` | 唯一 Home owner；CLI 使用实际 Web 存储的项目、会话、资源和七项权限，caller 不能伪造 SSH/凭据目录 | 原规范 ADK runtime；managed 调用走实际宿主 bridge；EOF 等工作结束再关闭 Home |
| Pilot、child / `@pilot`、`@child` | 当前父任务、具体授权来源、资源子集与角色上限；project allow 不强求虚假 grant | 自己的步骤/尝试/child scope，原 parent owner 可追踪 |
| SRE / `@sre` | 真实 SRE attempt 映射有限任务，队列和协作消息不签权限 | 原执行尝试和证据，不另开执行账本 |
| observation / `@observation` | 登记探针、有界实际读取，任意 SQL/命令输出不能冒充受信验收 | 当前目标/步骤/尝试和真实观察证据 |
| workflow / `@workflow` | 冻结模板、版本、资源和验收契约；每 run 关联任务 | 重启/续接不刷新绝对 TTL，不继承聊天单次审批 |
| schedule / `@schedule` | 独立 config/authority/status revision；原 dueAt 唯一 occurrence；授权有次数和期限 | ADK 内领取、扣次及任务登记原子化，Web run 幂等投影；恢复不追补 |
| MCP / `@mcp` | 实际 server、tool、binding、config/catalog/credential revision；自报 readonly 无效 | opaque 不支持任务通配，stdio server 还受本机禁令约束 |
| agent terminal / `@terminal_agent` | 原终端 generation、context revision、owner 和单写者；人工入口另行鉴权 | 写入前登记原 handle；只取消精确 agent 操作，不误杀人工终端 |
| provider continuation / `@provider_continuation` | 绑定原任务/owner/root，入场、等 slot 后、实际请求前复验；TTL 覆盖排队与网络 | 结束目标的合法最终总结去掉工具；过期、暂停或旧 owner 不可续派发 |
| Memory background / `@memory_background` | Memory 自己的同意、遗忘下限和提供者资格；任务 grant 不替代同意 | 不启用 Memory V2，不更换 bearqy 的内部权威；恢复未核实前暂停相关处理 |

## 实际适配器和限制

| 效果 | 本轮边界 |
| --- | --- |
| 本机文件/日志 | 有界 FD、`os.Root`、路径和身份校验，不跟随 symlink；保护 Lake 的 Home、runtime、控制面和凭据文件，范围授权不能开放它们 |
| HTTP | 固定解析/IP、重定向重审、响应/时间预算；正文仍是不可信数据 |
| Kubernetes | 固定 GET/list/log、namespace/资源身份和响应预算；不运行 kubeconfig exec 插件 |
| PostgreSQL/MySQL/Redis | 固定只读查询/命令、只读事务/服务端超时及响应上限；任意 SQL 不据分类文本获得任务通配 |
| 本机/SSH 命令 | 受信 profile/version、冻结 executable/argv/cwd/env 和准确服务集合；原始 Shell 不按前缀放行；SSH 退出不证明远端效果已停止 |
| 背景进程/终端 | 实际进程组或原终端精确 handle，当前 owner/generation；停止未确认仍保持未决风险 |
| 复合导入、任意交互及未约束工具 | 不能证明约束时按 opaque 或明确 not_executed；不宣称通用 OS 沙箱 |

`resource/resource_set/project/session/none` 是实际规范目标类型；发现/任务控制不强塞资源目标。model/API key/SSH 私钥不进入许可、审计或 SDK 状态；执行时只由宿主按 reference 读取。

## 恢复与风险

旧数据库按 source namespace 保全，不直接拼接 SDK 主键。恢复先推进 epoch、关闭 gate 并使旧授权失效。完整策略/连接映射确认后才激活；明确影响的未决副作用继续阻断相关写入，由新受限任务实际对账读取并逐来源核实。原 failed/unknown 不改成成功；G2 成功不会清除 G1 风险。细节见[成对恢复协议](checkpoint-and-recovery.md)。
