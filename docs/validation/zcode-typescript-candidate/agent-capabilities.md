# ZCode 通用 Agent 接入验证

2026-11-06。范围为固定 ZCode 3.17.2 的通用 Agent 内核及 Lake Task 资源适配。沿开放 PR 188 增量交付；普通默认构建/生产后端和完整 TS 产品切换门禁不变。

## 行为与归属

- Pilot、专员 Worker、原生临时 child 共享通用执行工具。Pilot 可以直接执行，首次实际业务/控制工具才建立原 Task；纯对话和路由不创建假执行。直接任务沿原轮次/目标、独立 Todo、准确 Operation 和有界工作集隔离；独立 Worker/child 使用独立 SDK Session。
- 原生 Bash 连接实际本机/SSH ExecutionPort；SSH 从准确资源与当前 configuration_revision 解析宿主私有凭据，首次/变化指纹仍须确认。模型能自主使用远端已安装的 kubectl/mysql 等 CLI，专用固定指标/数据库工具仍可复用。
- 本机 macOS Seatbelt 限制 Lake 私有 Home、正式 Home、SSH 密钥及 Keychain；不支持的平台拒绝本机 Shell。命令超时、输出预算、显式后台及前台等待超时转后台、十分钟总执行上限、TaskOutput/TaskStop 和父任务停止连接真实进程/通道。关闭 SSH 不证明远端副作用回滚，不透明中断保留 unknown。
- 前台/后台实际结果进入原 Operation。后台仍运行时不能验收；完成后原记录结算，不建立第二套完成权威。资源、配置/凭据、项目策略、父任务 generation 和权限在调用及回执使用时重验。
- SDK Plan 切换、AskUserQuestion 和 Skill 连接实际 Lake 交互/目录；退出计划须真实审批，不扩大后续权限。SDK 重新注册工具时，宿主包装仍保留。Todo、发现与协作控制不是业务成功证据。
- 固定上游在 Bash 分支隐藏 Glob/Grep；Lake 通过公开 handler 以 FindFiles/SearchText 接入相同能力。工具发现使用公开 auto/local 模式。图片通过 Jimp 原生 adapter 处理；保留全部实际打包依赖许可与原包遗漏的固定版本许可证。
- 点击历史 Pilot 轮次按该轮真实任务身份加载第三联，轮询保留准确 taskId；不能借用最新任务的子实例/工具回执。直接 Pilot 经验归现有项目 Memory，专员经验归稳定 RoleID，child 经父任务回流。

## 自动检查

在代码提交前通过：

| 检查 | 结果 |
| --- | --- |
| TS 类型、固定源码 bundle | 通过 |
| server + MySQL + router-context | 110/110 |
| Task/assets/activity/Memory/lifecycle | 57/57 |
| React 类型、前端测试与构建 | 653/653，Vite 构建通过；保留现有大 chunk 提示 |
| ADK runtime boundary | 通过 |
| Dev Home / 进程占用 / 构建来源保护 | 16/16 |
| 完整 TS parity | 按预期拒绝，118 项、20 个领域尚未全量验收 |

新增实际 SDK 测试包括：Pilot 直接 Bash 与原 Task、子智能体实际 Bash、后台汇合、秘密隔离、SSH 通用命令/后台实际退出、指纹确认前无认证、配置变化后旧批准不执行、危险命令即使启用普通命令免确认仍询问、Plan 重新注册后保护仍有效、问题回答续接、真实文件搜索/读写/编辑、任务 Todo 隔离、Skill 读取、图片模型投影、直接任务续接保留期限与累计轮数、停止真实命令与不透明命令非零退出保留未知结果、准确历史检查与跨项目拒绝、能力目录不虚报未接服务。Memory 补测 Pilot 已验收经验进入项目及原操作变更后的读取失效。

## 隔离界面复核

使用本机模型协议夹具、真实 SDK 和临时 Home 的 React 页面；没有派发用户历史比较或操作真实数据库。Ego Browser 同一 TaskSpace 验证两项独立 Pilot 任务之间切换、第一项原生 child 创建/结束与实际 Bash 输出、浅色/深色、820px 窄窗、Escape 关闭。焦点恢复未在动画结束后单独复核。合成截图只包含测试数据。

## 签名 Lake Dev

实际测试代码 SHA：`93b69953b90015b54df0dba7b990ea56475cc3e4`。在干净工作区通过 `scripts/build_lake_desktop.sh --dev --ts-candidate --install` 签名安装，build-origin 的 gitHead/dirty=false/backendSHA256 与实际安装二进制吻合。`codesign --verify --deep --strict` 通过，后端签名为 Lake Local Development Code Signing。

重新启动 `~/Applications/Lake Dev.app`，原生页面与 API 确认 backendRuntime=typescript、aiRuntime=zcode；能力目录给出 20 个已连接通用工具、23 个需宿主服务工具，当前模型原生 WebSearch 保持 model_dependent。Dev 使用固定 `~/.lake-dev`；原生页面保留 4 个专员和原目录，API 保留 144 个资源。对比安装前同 Home 私有备份，resources/superRoles/superGoals/superOperations 原记录逐项一致，启动后没有 active/queued Worker。

备份在 `~/Library/Application Support/Lake Dev/backups/full-agent-20261106-123452/`，仅本机私有保存；没有复制正式凭据。正式 Lake 未安装、未重启。此次构建仍保留 Node SQLite 实验提示、现有 Web chunk 体积与 Swift build-system 提示，不影响上述检查。文档跟进提交晚于此测试代码 SHA，不另称新版二进制。

## 明确边界

`GET /api/agent-capabilities` 遍历完整公开 builtInTools，给出 connected/model_dependent/requires_host_service 和实际别名。原生 WebSearch 只在固定上游编码器支持的 Anthropic 协议且模型显式启用时开放；真实供应商搜索未验收。动态工作流、Cron/OffPeak、浏览器桥接、跨 Session 档案读取还需对应宿主服务及范围适配，不注册成功占位。完整 TS 平台、附件、调度和既有安全产品等价验收未包含于本批。

本机 Shell 仅验证 macOS；Windows/Linux 隔离执行器尚未接通。PDF adapter 已连接，但依赖模型显式 PDF 能力及已安装 Poppler；PDF/视频/音频和真实供应商长期质量未作端到端验收。测试使用本机 SSH 协议夹具；没有对用户实际 K2、MySQL 或生产业务执行探测或改动。

## 回退

保留安装前 Dev 应用与同 Home 私有备份。退回旧 Dev 构建不重放 commandExecutions/superOperations；保留未知效果并核实。PR 未合并前保持分支可审阅；合并及生产发布分别遵守仓库授权要求。

## 免确认设置与查询包装修复（2026-11-06）

用户反馈：Pilot 的“运行命令”已开启，专员连续执行命令仍逐条询问。核对实际 Dev 记录，Pilot 保存值为 true，专员 SDK 中也有 Bash allow；当前 15 条命令中，旧分类器把 14 条程序发现或容器查询包装升为 dangerous，只有一条普通 CLI 查询没有升级。另有独立缺陷：Web 默认显示命令/数据库读取免确认开启，宿主把未保存的 undefined 当成关闭。

修复共享 Web 原有默认值到纯 shared 模块，前端与 TS 使用相同的确认偏好；显式 false 继续先询问。不改变持久设置、不签发新授权，不自动消费旧审批或重派任务。`command -v/-V` 只按程序发现处理；有限的 `sh -c/-lc`、Docker/Kubernetes exec 查询包装检查实际内部命令，支持常见信息读取与 MySQL/MariaDB 查询、表元数据及 CHECKSUM TABLE。多语句逐项检查，SQL 客户端系统命令、自定义初始化、提权、删除、嵌套动态代码和未识别结构仍要求确认。未引入通用 Shell/SQL 解释器。

这些规则只控制普通命令已获允许时是否追加危险确认，仍按 opaque 保存操作，**不**给予只读证明，也不绕过原项目 terminal.execute、当前连接版本、未知操作对账或父任务权限。补上未引用换行的命令分组，避免第二行的危险操作被前面的程序发现遮住。

同一批 15 条实际命令仅作离线分类，修复后均为普通 opaque 命令，无强制危险升级；没有重新连接用户主机或重新运行比较。CHECKSUM 的查询语义及读锁/全表读取行为参考 [MySQL 8.4 官方说明](https://dev.mysql.com/doc/refman/8.4/en/checksum-table.html)；不把校验和相同称作完整数据相同证明。

验证：TS 类型与 bundle 通过；后端集成 115/115；前端 683/683（含新增分类与拒绝绕过用例 30 项）；Task/Memory/lifecycle 57/57；ADK 边界通过；Dev 保护 16/16。实际 SDK/SSH 夹具验证默认值未保存、显式开启、显式关闭、容器查询内部 Shell 和危险操作。Docker/Kubernetes/MySQL CLI 在新增夹具中为本机测试程序，真实用户远端没有执行。原“必须等待确认”的测试现在显式设置 false，不再依赖与 UI 不一致的隐藏默认。PTY 危险确认使用真实危险动作的输入，仍验证缺少准确确认时不执行。

签名 Dev 的最终代码 SHA 和启动核对将在本次安装完成后记录；前述 93b69953 是上一批已验证构建。
