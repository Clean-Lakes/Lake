# Lake Security v1 · 第一批实施记录

日期：2026-10-30。代码基线：develop `be656805d345466f11bbb9c2c4af92e670da7420`。本批验证的代码提交：`e4515df3c4ccf89a8c71f29eb565b1d264124e84`；后续仅更新本文/计划进度时不改变该代码基线。总体方案见[设计 PR #124](https://github.com/Clean-Lakes/Lake/pull/124)，本批通过独立功能草稿[PR #130](https://github.com/Clean-Lakes/Lake/pull/130)交付，分支 `codex/security-runtime-foundation`，未合并。

后续新增代码`0feea12f`已补齐日常Home的项目与历史只读恢复，验证见文末；执行开闸尚未实现。前文保留首次基础版本与集成验证的历史记录。

## 五模块交付进度

| 模块 | 本批结果 | 未实施部分 |
| --- | --- | --- |
| 任务中心 | 保持现有WorkGoal/WorkItem及模型循环 | 跨轮次可信目标关联、版本化步骤、通用attempt/验收闭环仍按后续阶段实施 |
| SOP 手册 | 不修改SOP功能或前端 | 7份只读内置内容、目录API和工作区界面仍为独立计划 |
| 安全控制 | Home及DataDir双重OS owner锁、control/storeID/epoch、bootstrap/迁移中断拒绝、SDK迁移前reader guard；在invoke/bridge/终端路由/定时入口检查gate | TaskGrant、确定性能力内核、逐派发事务、owner租约、孤儿取消与恢复管理开闸仍未实现 |
| 资源操作 | [完整清单](../security/tool-entrypoints.md)及[93个静态工具映射](../security/tool-entrypoints.json)，覆盖测试对照实际目录；Web/stdio共享规范RuntimeRoot | 全部适配器的能力登记、冻结操作描述及原子授权检查是后续阶段工作 |
| 任务档案与验收 | 保留原ADK/nativeOperation/nativeEvidence；首次迁移一致快照、稳定legacyStoreID和摘要清单、未决状态统计 | 旧操作逐资源映射/查询与显式核实闭环、AcceptanceRecord/CoverageLink/GoalClosureView仍待实施 |

对原第一阶段任务：TASK-001入口盘点、TASK-002规范Home/owner接入已交付；TASK-003先交付control/reader guard，完整checkpoint/跨设备恢复协议仍待完成；TASK-004先交付快照/迁移清单及保守隔离，TASK-005先交付现有专项与回归证据。旧账本逐资源索引/显式核实、完整迁移断点矩阵、日常Home恢复和窗口交互补验未完成，不能宣布整个第一阶段退出，更不能开启完整Security enforced模式。

## 本批可观察行为

- `lake ai --home PATH`与Web使用control指定的同一个`<DataDir>/adk/sessions.sqlite`；不再默默另建`ai/adk`。同Home、同DataDir第二owner拒绝；自定义DataDir持久绑定后，Web/stdio都跟随manifest，stdio会话文件也位于同一DataDir。旧Web的存活/可能复用PID记录也要求先核实，不删除记录或杀进程。
- control私有原子写入并落盘；普通重启保留epoch；恢复准备只提供“轮换epoch并关闭gate”的后端原语，没有通用开闸接口。缺control、未来reader、已初始化库丢失、迁移中断、归档损坏等情况保留证据并拒绝启动。
- 两份旧库不拼接SDK主键。不明、未登记终态或双库情况先保存SQLite一致快照（包含已提交WAL），以源namespace保留原记录，再关闭整个Home。归档不等于副作用已核实，也不导入旧审批为有效授权。
- 当前迁移隔离是Home级保守阻断；无按资源核实/开闸接口。已初始化的迁移清单丢失时不自动重建，以免使用旧快照抹掉后来新增的未知记录。不得手工删control/清单、修改gate或用旧二进制绕过。
- 保留现有权限规则与界面。前置gate检查不等于已经实现逐派发事务、OS沙箱、原子撤销或任务一次授权；本批没有扩大任意Shell能力。

## 验证证据

| 检查 | 实际命令/环境 | 结果 |
| --- | --- | --- |
| Go专项 | `go test ./internal/ai ./internal/web -run '^TestSecurity' -count=1` | 通过；93工具覆盖、跨进程锁、共享DataDir拒绝、epoch失效、双库/WAL/状态保留、缺库/缺清单/损坏/中断/未来版本/路径别名等 |
| Go完整回归 | `go test ./internal/security ./internal/platform ./internal/agent/storage ./internal/ai ./internal/web ./cmd/lake -count=1 -timeout=8m` | 通过；最终代码SHA下AI 46.753秒、Web 239.543秒，其余相关包通过或无独立测试 |
| race | `go test -race ./internal/ai ./internal/web -run 'TestSecurity\|TestADKRole.*Recover\|TestSRE.*Recover\|Test.*HostKey' -count=1` | 通过；专项与选定旧恢复/SSH回归；未声称全部测试均跑过race |
| 静态检查 | `go vet ./internal/security ./internal/platform ./internal/agent/storage ./internal/ai ./internal/web ./cmd/lake`；`python3 scripts/check_adk_runtime_boundary.py` | 通过；未新增模型调用循环或导入SDK内部API |
| 前端兼容 | Node 24.19.0、pnpm 10.33.4；`pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend` | 通过；556项前端测试，前端源码/shared契约未修改 |
| Windows | `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c ... ./internal/platform` | owner/进程检测平台包交叉编译通过；未在Windows真实运行 |
| 签名Dev构建安装 | `scripts/build_lake_desktop.sh --dev --install` | 单独分支安装先被03ea24a251f1来源保护拒绝；用户授权合并卡片后，将两边源码集成为42e1f411a31f56496e7079abea5c5e45bc8306f6，正常签名构建安装通过，dirty=false，未绕过保护或操作正式版 |
| 最终签名后端 | `scripts/build_lake.sh`后运行`python3 scripts/verify_security_runtime_dev.py --binary bin/lake --output <private-result>` | 通过；最终e4515df3的签名后端在隔离Home下验证第二owner拒绝、释放后同库/epoch不变、未来reader拒绝、旧unknown归档关闸无重放。9ed31220及集成42e1f411的已安装Dev后端也通过同一验收 |
| 自定义目录 | 签名bin/lake：环境指定自定义DataDir启动Web→同Home stdio configure→显式--home重启Web | 通过；会话仍保存到自定义DataDir，环境中的其他DataDir未覆盖已绑定root，无模型请求 |
| 原生窗口 | 以上脚本加`--native '<Lake Dev.app>/Contents/MacOS/Lake'` | 隔离原生启动及同库/owner/gate验收已通过。真实WK窗口显示合成会话，实际JS/CSS字节与clean集成构建一致，未执行资源工具。原生动作接口报告状态变化，未声称窗口拖动及卡片全部交互已通过；日常Home恢复仍待处理 |
| 补丁 | `git diff --check` | 通过 |

首次完整运行曾因新清单测试错误地将多语言description解析为string而失败；已改为仅解析真实工具名，93项覆盖测试及后续回归通过。曾有一次旧源码测试运行主动中断，它不计入通过证据。最终代码测试记录以上述SHA为准。

## 剩余工作与回退限制

本批属于基础能力，并未完成五模块全部69项任务。继续完成第一阶段的细粒度旧账本核实与迁移故障矩阵、实际原生重启验证后，才能进入目标/步骤/尝试/验收和TaskGrant等后续阶段。已通过本地集成42e1f411保留03ea24a251f1源码并完成Dev安装；日常Home恢复和原生交互补验仍按门槛继续，不绕过来源、单实例或迁移保护。

没有生产访问、凭据迁移、Release或标签。Home增加了持久控制与guard元数据；不支持回退到不认识control/epoch/schema的旧历史二进制。隔离验收Home随测试清理；真实Home需保全并通过后续受控恢复管理，不能通过删除账本、清单或control回退。当前没有可批准的完整恢复开闸流程，相关故障保持管理阻断。

## 卡片 PR 合并后的集成

用户明确授权合并更新[PR #131](https://github.com/Clean-Lakes/Lake/pull/131)，已核对其head `0e6216be587579c64f1ba9b99c3b2db171ae4ea6`经GitHub squash合入develop `8ae90c27d526efd0e9b6fbc69dad00328c87749c`；本分支通过合并origin/develop同步，无保护分支直接推送。Security PR #130保持草稿，diff不包含卡片前端改动。

Dev集成42e1f411的前端与卡片PR源码一致，后端与e4515df3一致；补跑556前端测试、类型、Security专项和ADK边界通过。真实原生隔离窗口加载JS `index-CA00KQkZ.js`、CSS `index-DnbvT5Oj.css`，二者与构建文件字节一致，安装后端摘要与build-origin匹配。原生fixture结束时先停止其自己创建的后端，再关闭测试窗口，确认没有遗留Dev测试进程。日常Home中尚未完成的Security迁移标记及gate未删除或强行修改。

## 迁移中断后的项目只读恢复

恢复补丁代码：`0feea12f`。已有Dev Home的数据库及历史文件仍然完整；迁移在保存旧库快照后中断，留下`legacy-inventory.pending`并关闭gate，原启动路径连项目查看也一并拒绝。本补丁恢复同一Home下现有项目、资源、消息、AI卡片和SRE任务的本地只读查看，不代表执行能力恢复或旧副作用已经核实。

- 只接受有效、版本受支持、根路径匹配且gate已关闭的control；继续持有相同Home、DataDir和Web Store owner锁。guard存在时检查schema/reader/storeID/epoch；已初始化库缺guard、身份不符、未来reader、bootstrap中断等情况仍拒绝。
- Web与ADK数据库使用SQLite只读连接。恢复路径不调用普通Store/Engine构造器、SDK迁移或操作对账；不创建终端、扩展、WorkManager、调度或记忆/模型后台任务。SRE历史直接读取已存body，避免普通列表读取时的隐式命令对账。
- API仅放行经过检查的本地读取：bootstrap、catalog、会话snapshot/AI卡片分页、已有消息队列、会话模式/选项、历史事件流。其他请求统一409，包括具有网络副作用的GET、模型测试、命令、审批、恢复操作结果和所有写接口。SQL只读连接及Store写入口同时拒绝写入。
- 该进程不能切换到执行模式；control变化后读取也要求重新启动。RotateRecoveryEpoch、InventoryLegacyStores和MigrateLegacyStores均拒绝只读owner。原control、pending、未知操作、结果及handle保持原样，不删除标记、不伪造终态、不重新派发。
- 没有前端或原生界面改造；恢复范围不包括资源连接、模型调用、终端、配置编辑、SOP UI或完整受控恢复开闸。旧审批和进度仅作为历史展示，不授予执行权限。

验证结果：恢复补丁完整Go回归通过（AI 46.403秒、Web 227.301秒、cmd/lake 1.223秒）；最终代码额外通过`go test -race ./internal/ai ./internal/web -run '^TestSecurity' -count=1 -timeout=4m`、Go vet和ADK边界检查。新增测试模拟pending中断和unknown操作，核对数据库/control/pending/历史文件摘要不变、凭据脱敏、只读SQL与API拒绝、未来reader及错误身份拒绝、相同owner互斥和实际Start不创建执行服务。签名后端的原有隔离验收脚本也通过。

真实Dev Home先在持有三组owner锁时备份Web/ADK一致快照和control/pending，备份位于`$HOME/.lake-dev/security/recovery-backups/<UTC>/`，权限0700/0600。签名后端逐一读取全部33个现有可见会话成功；可见目录为4项目/138资源。数据库物理记录5项目/61会话/141资源，包含原已隐藏记录，未做恢复删除项操作。验证后两个原库及control/pending的SHA256与备份清单一致，93条unknown及其他操作状态计数不变。真实数据内容、凭据和会话名称未放入自动化验收文件或仓库。

最终通过`scripts/build_lake_desktop.sh --dev --install`安装代码`0feea12f2154e12a4217a64aca720dc233ac8360`，build-origin为dirty=false，签名及来源保护均正常。真实日常Lake Dev窗口已显示原项目导航、资源列表和既有会话内容，现有错误提示区显示只读恢复说明；原生启动后的bootstrap确认`recoveryReadOnly=true`。没有执行资源命令或模型请求，也未操作正式版。

本节补齐的是日常Home的查看可用性；逐资源核实、受控迁移续跑与执行开闸仍待后续实施。PR #130保持草稿，不据此宣布整个第一阶段或Lake Security已完成。
