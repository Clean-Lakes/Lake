# Lake 执行入口清单 · Security 基础阶段

基线：develop `be656805d345466f11bbb9c2c4af92e670da7420`。本清单落实五模块计划的“资源操作”入口盘点。机器可核对的完整静态工具名与分类保存在[JSON清单](tool-entrypoints.json)，`TestSecurityEntrypointInventory`对照实际内置/角色/项目记忆/工作目标/观察目录检查遗漏和退役项。动态MCP另按受信server/tool/config身份登记，不能把外部自报readonly作为授权依据。

本阶段仅增加Home/存储身份、reader guard和恢复门禁。清单不是新的运行时能力注册表，现有权限与原生审批仍按原规则工作；统一TaskGrant、逐派发事务、全量attempt/acceptance和owner租约属于后续阶段，不能据此宣称已完成。

## 主机入口与持久化归属

| 入口 | 身份来源与目标 | 当前执行/审批/账本路径 | 本阶段变化与后续约束 |
| --- | --- | --- | --- |
| `cmd/lake: ai` → `ai.ServeHome` | CLI明确Home；stdio协议来自继承管道，模型不设置Home | `Engine.Handle` → `ExecuteTurn` → ADK工具；桥接callback由宿主实际执行 | 与Web使用同一control中的RuntimeRoot；同Home或同DataDir第二owner拒绝。旧任意`--data`不得静默推断归属 |
| `web.New` → `agent.go:runTurn` | 鉴权本机Web/桌面、当前项目/会话与真实资源 | `Engine.invoke` → 原生approval/operation或早期分流 → bridge/适配器 | 在资源库、模型或调度初始化之前获取owner并校验control/存储guard；无新增UI |
| `Engine.invoke` 常规入口 | 后端会话Config、已验证工具参数、真实资源/终端 | 现有policy、preview、confirmation、`dispatchNativeOperation`与`nativeEvidence` | 入站检查gate/epoch；后续阶段仍须在派发事务复核授权/版本，早期检查不是原子撤销保证 |
| `Engine.invoke` 早期返回 | natural recall、Pilot、sessionTool、memoryTool、调查委托等 | 可能不经过通用`dispatchNativeOperation`，各自已有权限/证据路径 | 新gate检查在所有早期返回之前；仍须逐项接入后续能力内核，不能因控制类无资源而强塞CurrentTarget |
| `invokeSessionTool` | 原会话/项目、父角色限制；SRE/work目标有自身记录 | MCP、工作目标、todo、问题、技能、工具结果、子任务控制及workflow/schedule桥接 | gate由invoke和Web bridge双侧检查；宿主响应中的approved不是独立权限 |
| `Server.bridge` | 已校验会话及resource映射、host配置/凭据reference | 提前分流extension/project/memory/attachment；host `policy`、`inspectHost`、`runtimeCommandExec`等 | bridge最前检查gate；保留host trust、终端generation和权限规则，不用模型传入resource ID扩大范围 |
| `Server.terminalRoute` | 已鉴权人工/agent调用、TerminalAccess、owner/generation | adopt/control/execute/input/key/interrupt/close，`terminal_access.go`校验单写者与权限 | gate关闭时不派发；后续重构仍保留人工终端与agent借用的区别 |
| SRE/Pilot/child | 主Engine创建的父会话/轮次/角色/资源子集 | `scopedChildConfig` / `ExecuteSRERole` / `runInvestigations`，原SRE attempt与原生证据 | 子Engine共享父SecurityHome，不能开第二store或在epoch变化后继续；租约/角色授权交集在后续阶段完成 |
| workflow run | 鉴权启动、冻结工作流版本、目标与继承选项 | `startWorkflow/executeWorkflowRun`，工具调用继续进入invoke/bridge | 不新增工作流入口；后续每run有独立SecurityTask，不能把状态更新当新权限 |
| `executeSchedule` | 持久schedule所属project/session及现有配置 | 现有限次/版本检查后启动workflow，状态持久化 | 派发前检查gate；config/status/authority版本及occurrence事务拆分仍在后续计划 |
| `adkStore` / `storage.OpenChecked` | 共享SecurityHome中的storeID、epoch、RuntimeRoot | 原官方ADK session库和应用原生表；SDK public AutoMigrate | 在任何SDK迁移之前验证reader guard及Home绑定；未来版本/身份不符/中断迁移拒绝，禁止另开库绕过 |

## 实际 I/O 分类

下表按职责分组，具体工具名以JSON和覆盖测试为准。`resource/resource_set/project/session/none`是后续能力注册表的目标分类，不代表本阶段已新增对应授权。

| 分类 | 实际I/O/定位 | 权限与证据边界 |
| --- | --- | --- |
| files | `Engine.file`：本机文件、SSH/SFTP、容器文件；读取、hash预览及写入 | 路径/目标、文件权限、原preview与approval；符号链接、读取秘密和二次执行不能靠名称证明只读 |
| host-terminal | `command/terminal/shellJob`、Web Terminals与持久终端 | 本机exec/PTY或SSH命令、输入/信号/关闭；记录原handle；任意交互不是安全模板授权 |
| database | `database/redis`：数据库driver与Redis连接 | 逻辑库/账号、真实服务端权限、SQL/Redis现有分类和审批；实际执行结果进入原操作证据 |
| container-cluster | `docker/queryKubernetes/kubernetesOperation` | 容器/K8s API或受控命令；配置、namespace与工作负载身份是约束，不因工具名推断只读 |
| transfer | `transfer/stage_attachment`：隧道、SCP、附件中转 | 来源/目的地、overwrite与校验；中转路径有副作用，不能只审原目标 |
| web | `Engine.web`：HTTP获取与搜索 | URL/解析/重定向与预算，页面内容是不可信数据，不能签权限 |
| observation | 固定观察器、委托子Agent、已登记证据分页 | 有界SSH/数据库/K8s观察与已有证据读取分开；角色不能升级为任意shell/SQL |
| task-coordination | WorkGoal/SRE/Pilot/child状态与审计；控制可能启动后续实际I/O | control动作身份由宿主决定，计划文本/结论/工具参数不能签grant；停止请求不等于远端已停 |
| workflow-schedule | workflow模板/运行与schedule配置、状态JSON | 启动/修改/撤销是不同控制动作；派生执行仍走资源约束，不能继承聊天单次批准 |
| extension | 本机MCP目录、server进程/网络请求与工具 | 绑定实际server/tool/config revision及资源映射；opaque工具不接受按名称通配 |
| resource-catalog | 资源目录发现、附件/HexHub导入预览及提交 | 发现和写入分开，目标选择不签权限；导入包含真实资源配置但凭据不回传模型 |
| session-content | 会话/todo/question/skill/result/chart、项目记忆读写 | 本地文件/数据库或宿主bridge；记忆和技能是内容，不是可信控制面 |

当前没有资源级旧库风险解锁接口：发现旧stdio数据库或首次迁移中的unknown/dispatched/running操作，会先保存一致快照和带namespace的索引，关闭整个Home的gate并要求管理。后续资源级核实完成前不能手工删除control/索引或改gate开闸。两份旧库绝不按整数SDK主键直接拼接；“已备份”不等于“已核实”。
