## 当前：移除聊天框 Plan 按钮（2026-11-12）

源码与签名 Lake Dev 已测试：`90bd0cbdfe71133724a37352fbbb43d50fce00ec`。移除输入工具栏的 Plan 按钮、专用组件和样式；计划列表的空提示改为 Pilot `/plan` 指令。指令解析、已有模式／计划和执行／修改计划操作保留；没有更改后端或会话配置。删除了一项仅对应已移除按钮的旧渲染测试，其余测试保留。

前端类型、全部 804 单元、ADK 边界和规定的签名 Dev 构建安装通过。演示工作台浅色 1280px／深色 380px 验证无 Plan 按钮、无横向溢出、其他工具均在栏内；Tab 从附件正确进入权限。实机 Pilot 的可访问树确认 Plan 入口已消失，附件／权限／模型／发送入口正常。签名严格校验、clean 来源与实际后端 hash 一致：`3ccf137c0bf1a65d5d9be427ec1e5cef8dbcdcf7ff2b3c1467a042a8eee4a809`。本轮新 hash 基线确认原配置、全部业务记录、扩展／Skills 及本机 Codex 配置不变；没有模型调用、业务命令或完整备份，四处已删除备份根目录仍不存在。演示浏览器与专用 Vite 已关闭，Dev 保持运行。

本机日志为 `/tmp/lake-no-plan-button-{types,front,boundary,signed-build,preserved-before,preserved-after}.log`，截图为 `/tmp/lake-no-plan-button-{light,dark-380}.png`；未重跑后端、Go／race／vet、其他平台或真实业务操作。原后端与协作头像验证继续对应下方各自源码 SHA；回退通过源码回退与签名 Dev 重建，保留原数据，不重放旧操作。PR 仍为 develop 草稿，没有合并或生产发布。

## 当前：任务行预留协作专员头像组（2026-11-12）

源码与签名 Lake Dev 已测试：`be01b280a0e805133533bab3011da3ed25a56aaf`。单人任务保留原头像与身份列，多人直接读取原 collaboration.participants，按准确专员身份展示紧凑头像组及 +N，完整姓名保留提示和无障碍描述。列表统一对齐，每位成员独立运动；轮询、成员增减／排序及头像配置变化保留原节点与焦点。不更改后端协作调度或日常任务数据。

805 前端单元、类型、签名构建、边界及命名通过；浅／深色 1280／620／380px、1／2／3／6 人、键盘、隐藏／减少动态效果与原生 34 项任务验证通过。原配置及业务记录、本机 Codex 配置逐条 hash 一致，无完整备份。详见[协作头像验证](task-specialist-avatars.md)。后端无改动，下方后端测试继续对应原实际测试 SHA。

## 当前：新专员随机 Agent／模型并保存（2026-11-12）

源码与签名 Lake Dev 已测试：`8a2a0fd0bde21b09c0da6534fa560d044bcd662a`。Pilot 新建专员时，未指定的 Agent／模型从已配置可用组合中随机选择一次并落盘，明确的选择保留；隐式创建沿同一规则。原生 Worker 实际使用保存的 provider/model，Codex 通过独立启动配置使用指定模型，保留本机登录与 max。创建重试、局部更新、原 Worker 及旧角色不重抽；当前 Codex 兼容目录仍只有 gpt-6.1-sol。

286 后端单元通过／4 既有可选跳过、226 宿主／服务／配置通过、5 固定真实 Codex ACP 通过、800 前端通过；类型、签名构建、边界和命名通过。实际原生请求在 Pilot 换模型和重启后保持所选模型，Codex 实际请求及冻结引用相符。原 provider／settings、角色与全部业务记录、本机配置逐条 hash 一致，无完整备份。详见[随机执行配置验证](specialist-random-execution.md)。下方“新专员默认 Codex”仅保留历史；旧未绑定专员继续兼容原默认，当前新建规则以本节为准。

## 当前：移除任务状态、核实与验收（2026-11-12）

源码与签名 Lake Dev 已测试：`8d54b178bae6bbf0fdcc15fa6580f44e5ca07a07`。专员页改为无状态标签／分类的完整任务记录；后台以 completed／partial 报告结束执行，不再要求待核实结清或创建步骤／最终／共同验收。历史 unknown 不阻止新调用，原 ID 不重放；当前权限、Plan、执行归属和真实子任务等待继续有效。原记录及旧验收只作兼容历史；新 Memory 来源明确为已返回观察，不冒充独立验收。

278 后端单元通过／4 既有可选跳过、225 宿主／服务／配置通过、4 固定真实 Codex ACP 通过、800 前端通过；类型、签名构建、ADK／限定旧 Go 静态边界与命名通过。明暗／窄窗、节点与焦点稳定及原生 34 项任务验证通过，原资源、配置、业务记录和本机 Codex 配置逐条 hash 一致，无完整备份。详见[报告生命周期验证](task-report-lifecycle.md)。下方旧“验收通过／待核实／按状态分组”描述保留当时历史，由本节新规则替代；本轮不证明真实模型耗时或业务系统健康。

## 当前：专员任务页移除目录枚举（2026-11-12）

前端与签名 Lake Dev 已测试：`409c31ef1cca3325f28de04983511c8d7a54c232`。任务行与详情头部不再列举资源目录，保留目录搜索、原绑定和执行 Agent。前端类型、8 项相关单元、签名构建、浅色/窄窗深色与实机检查通过，原业务数据及本机配置哈希一致。详见[本轮验证](specialist-resource-paths.md)。后端未改；下方全量回归继续对应其各自实际源码 SHA，未标为本轮重跑。

## 当前：Pilot 自然语言配置 CRUD（2026-11-11）

源码与签名 Lake Dev 已测试：`9dd23954be16411acbed3b55d4665dd9968f2f9d`。Pilot 直接管理当前项目资源/文件夹与 Lake 全局 Skills/注册目录/MCP 配置，提供准确版本与有界目录，局部修改保留凭据和原 MCP 工具范围。资源沿原回收站，管理 Skill 可回收、导入项只解除注册；MCP 保存和显式连接测试/项目绑定分开。当前完整人工来源、权限偏好、Plan 与待确认提交不重放继续生效；Worker/child/ACP 不接收配置控制权，纯配置不制造业务任务或验收。

275 后端单元通过/4 既有可选跳过、225 宿主/服务/配置通过、4 固定真实 Codex ACP 通过、800 前端通过；类型、构建、边界与命名通过。实际 SDK 中文 CRUD、重启、写入批准/拒绝及实际 MCP 两页目录/精确绑定通过；真实外部模型意图可靠性与实际业务系统未测。签名 Dev 启动正常；全部原资源、目录、扩展文件、任务与本机 Codex 配置哈希保持，日常配置 mutation 为零，无完整备份。详见[验证](pilot-configuration-crud.md)与[结构化记录](pilot-configuration-crud.json)。下方历史记录保留各自实际 SHA 和当时范围。

## 当前：轻量专员任务工作台（2026-11-11）

前端与签名 Lake Dev 已测试源码：`73e1755c162fde814b57a2f79019cca4770727ac`。专员任务表格替换为无外框的双行列表，真实状态、执行 Agent 与实际进度置于标题下方，时间置右；全部任务按现有状态完整分组，搜索与单一筛选平铺。所有任务、Worker 身份、原顺序及验收保持，状态跨组时复用原行和头像节点。专员输入框/新建仍不挂载，前台总览的准确通知确认及 Pilot 草稿保留。

800 前端单元、类型、独立/签名构建及边界通过；明暗、1280/1140/620/380px、焦点/悬停/选中、准确问题与停止路由、轮询及滚动保持通过。签名实机显示原 34 项任务；新建的私有哈希基线确认当前全部角色、频道、任务、业务记录及本机 Codex 配置安装前后一致，没有重新创建完整备份。详见[本轮验证](specialist-workbench.md)。后端未改且套件本轮未重跑，下方后端测试仍对应其各自源码 SHA；旧表格外框/列布局说明保留历史背景，由本节替代。

## 当前：Pilot 自然语言专员配置（2026-11-11）

源码与签名 Lake Dev 已测试：`afbfe85ed6cff7c1d30a4e48c70d76a64559f1a9`。Pilot 使用原 manage_specialist 对名称、职责、头像及后续默认 Agent 做局部更新；头像查询与前端共用 100 项本地图形，auto 恢复原 RoleID 默认外观。保留人工原文来源、项目/版本及幂等事务，已有任务职责与执行绑定不变；不修改本机 Codex 登录、模型、max 或资源权限。

275 后端单元通过 / 4 既有跳过、199 宿主通过、4 真实 Codex ACP 合成服务通过、799 前端通过；类型、构建、边界及命名通过。真实 SDK 的合成模型场景完成创建/局部更新/重启/auto，零业务任务；明暗/窄窗共享头像、原图形回退、节点/相位及 Pilot 草稿通过。签名 Dev 启动、全部原角色/频道/变更与业务记录、本机配置哈希核对通过。配置写入回归在隔离测试中进行，原头像失败输入不重放。详见[本轮验证](pilot-specialist-config.md)。下方历史记录保持其实际 SHA。

## 当前：专员总览自动确认通知与布局（2026-11-11）

前端与签名 Lake Dev 已测试源码：`ea863e7016bffbe67226e4ba7180a80e8e1f88cf`。按用户反馈，成功加载的专员总览在前台可见后自动确认该频道已交付的通知；后台、inert、未聚焦、原生 attention 拒绝、断线或列表失败时不确认。保存失败保留点并重试，旧回执与其他专员仍按准确 cursor/session 隔离。这取代下方历史“任务列表本身不清未读”的交互，不代表读完报告或完成验收。

恢复侧栏角色选中高亮，移除重复统计和无资源时的重复占位说明，收紧页头和行距，Agent 和状态保持单行。798 前端单元、类型、构建及边界通过；明暗/窄窗、失败恢复、新消息竞态、跨角色、原任务问题与焦点通过。签名实机 34 项任务正常，原绿点重启后仍无；全部原业务记录、本机 max 配置哈希保持。详见[本轮验证](specialist-unread-layout.md)。本轮没有后端改动，下方 SSH/后端测试保留各自源码 SHA，不标为本轮重跑。

## 当前：SSH 自动换钥与专员任务总览（2026-11-11）

已测试源码与签名 Lake Dev：`cf444aa0618a6e063588e0cef0369d27f53c15c7`。用户进一步明确要求已存指纹变化也自动信任并连接；首次和换钥均沿原校验、私有原子保存路径在认证前落盘，不发布指纹弹窗，跨算法换钥同样支持。保存失败不认证、保留旧记录，旧 peer 证据和失效决定不能覆盖当前信任。此策略取代下方历史“变化须人工确认”的限制，不提供独立主机身份核对。

专员角色页取消输入框、“新建任务”和资源添加到对话入口，由 Pilot 派单；任务列表、未读、问题及审批详情保留。272 后端单元通过 / 4 既有跳过、198 宿主通过、4 真实 Codex ACP 合成服务通过、798 前端通过，类型/构建/边界/命名通过；浅色与深色窄窗交互、签名实机 34 项任务及原数据/本机配置哈希核对通过。未新建完整数据备份，未连接真实服务器、重试业务任务或更改本机 max。详见[本轮验证](ssh-roles-overview.md)与[浏览器证明](ssh-roles-browser.json)。下方记录继续保留各自的测试 SHA 和当时行为。

## 历史：SSH 首次后台信任（2026-11-11）

签名 Lake Dev 已测试源码：`603d4491f7f9083112537e3154e48d7aadcb9187`。按用户要求，首次没有已存公钥时在后台沿原接受路径保存并连接，不发布首次指纹弹窗；已有不同公钥仍需准确确认。取消后的失效协议回调不再进入已销毁的连接。后端单元 272 通过 / 4 项既有跳过，宿主 196 通过，真实 Codex ACP 4 通过；签名来源、原生任务页、原业务记录及本机配置核对通过，未重新创建完整数据备份。详见[本轮验证](ssh-first-use-trust.md)。

下方历史记录中的“首次指纹须人工确认”保留当时测试范围，当前策略以上述用户修订为准。此轮没有连接实际服务器或重放旧任务，不改变既有操作权限及验收。

## 当前：结构化回执与异常清理（2026-11-11）

签名 Lake Dev 已测试源码：`c521f01867b241b7f3485411928934f810bb5d5a`。真实回执中的 JSON 解析错误来自整段序列化文本脱敏误伤数值字段；原命令内部 promise 未结算，既影响验收也可能阻碍清理。已改为共享结构化脱敏并保证失败时记录 unknown、结束等待、继续底层关闭。后端单元 272 通过 / 4 项既有跳过，宿主 193 通过，真实 Codex ACP 4 通过。签名来源、实际原生任务页、全部任务/操作/报告/命令和旧版记录保留通过，本机 max 配置未变。详见[本轮验证](structured-receipt-redaction.md)。

此前未读与流程调整未解决此回执错误。本轮不改写历史报告或未知结果，没有重跑实际服务器，也没有真实模型耗时或全部关闭路径的验收。下方记录保留各自实际测试 SHA 与范围。

## 当前：专员未读与任务流程（2026-11-11）

签名 Lake Dev 已测试源码：`b77ab66b6664a9fe78dced26e90fd3a1f841e8f7`。未读显式确认、报告可见性及调用流程验证见 [本轮记录](specialist-read-latency.md)。按用户选择保留本机 max；真实模型加速未测量，原未决结果不清除。目录检索等本 PR 功能继续保留。

## Agent 按 Lake 资源目录检索（2026-11-11）

已测试后端与签名 Lake Dev：`f93cd200f14ba2bbf3f244698bb9d64cc5041594`。实施见[目录修复计划](../../../plan/refactor-agent-resource-directory-1.md)。

只读审计原 Codex 调用确认：先按用户给定目录名查询，结果为空；随后按共享入口 IP 查询，只命中另一目录的构建主机。再次按 Kubernetes 名称查询仍为空，分页浏览也只有资源名/ID，没有祖先路径。Worker 没有限定到该构建主机的 targetResourceIds；资源工具缺失目录语义，使模型无法从列表识别环境归属，后续选择了错误的资源 ID。本节不公开个人资产 ID、连接或原始模型档案。

- list_assets 从同一当前 catalog 读取已过滤的资源与资源树，返回完整路径，并按资源名、ID、祖先目录或完整路径匹配；原生 Worker、child 与 ACP 共用该实现。工具说明要求先确认目录归属，不把共享网关 IP 当作相同主机/集群。
- 保留精确 ID、连接 revision/pin、项目/任务范围与执行资格。相同名字、IP 或网关的资产保持独立。目录元数据不代表访问授权、集群入口或健康证据，也不能保证模型永不选错。
- 路径按 JSON 编码限制 2048 字节，截断明确标记；页上限仍为 8192 字节，依旧分页。目录改名/移动使旧 cursor 失效，即使移动前后显示路径同名。循环、断链、跨项目或重复目录不猜测归属，显示 path_state=unavailable。

| 本轮检查 | 结果 |
| --- | --- |
| 后端类型与构建 | 通过 |
| 资产单元 / 全部后端单元 | 20/20（包含在全套内）；全套 267 通过、4 项既有可选跳过 |
| 宿主集成 | 192/192 |
| 固定真实 Codex ACP | 3/3；adapter 2.2.2、engine 0.160.1、本地合成 Responses 服务；真实 Codex 经宿主工具桥按虚构目录查询，收到完整路径且不含另一目录的 Jenkins，再经原 Read/work_finish 完成原任务回执与验收。无真实凭据或外网推理 |
| 实际目录快照 | 同一份 Dev 元数据，原扁平目录名查询为 0 项，新实现为目标目录的 27 项，无 Jenkins；只做本地元数据投影，未调用业务服务器。见[证明](resource-directory-projection.json) |
| 边界 / 命名 / 命名单测 | 通过 / 0 违规 / 5 项通过 |
| 签名 Lake Dev | 脚本构建安装成功；准确 SHA、dirty=false、深度签名、backend hash 与实际进程路径核对通过，原生专员任务页正常 |
| 原记录保护 | 19 个项目的 150 个 Worker 身份、状态与执行绑定保持；原任务 28 项操作的身份/状态/输出哈希、全部 3 个外部运行保持，原 6 项 unknown 不结清或重放 |

本轮前端源码未改；签名脚本重新通过 Web 类型与构建，原前端 797 项测试保留其源码 `d389ca7847ddcfb9537a14fb32bffa018ccb0c97`，未重复标作本轮运行。旧 Go/race/vet 未重跑。没有重新检查实际 Kubernetes 集群，没有改派原错误目标任务，也未修改非命令 MCP 的恢复门禁。正式版未安装或重启，草稿 PR 未合并。

## 当前：带头像的专员任务页与加载动画（2026-11-11）

已测试代码与签名 Lake Dev：`d389ca7847ddcfb9537a14fb32bffa018ccb0c97`。用户确认渲染图并要求先完成前端，后端问题留待后续；本轮未修改 runtime 或 shared 协议，后端源码仍为 `219636df81270129a1a47279e86ee2b29ead33e4`。见[实施计划](../../../plan/refactor-specialist-task-page-1.md)。

- 专员主页面以角色信息、共享湖生态头像和任务列表替代消息流；Pilot 保持现有对话。搜索覆盖任务名称、执行 Agent 和当前项目资源目录，筛选全部、进行中、需关注与已完成。
- 行内显示原 Worker 的准确任务及冻结执行绑定，已验收、待验收、失败和停止保持区别。没有真实记录的进度显示“未报告”；已读取的详情用于补齐对应行，不逐行增加请求。
- 任务行打开原 session/task 的右栏，步骤、最新活动和结果采用真实记录；完整执行过程默认折叠。确认、主机信任与停止仍指向原任务，未改变权限或验收。新建任务只聚焦原输入，保留草稿、附件与模型菜单。
- 轮询保留筛选、搜索、行节点、选中项与加载动画；关闭任务详情恢复原行焦点。长列表取消聊天末尾跟随；43 行展示夹具在滚轮结束后停留在约 600px，未跳至底部（采样初值 574px 包含剩余滚轮惯性）。列表浏览本身不清除频道未读。
- loader Glyph 统一接入原共享动画；对话卡、任务状态、Worker 与外部运行的五处图标在刷新后保持同一节点/Animation。已结束不再转圈，减少动态效果时静止，页面隐藏时新任务页暂停工作动效。

| 本轮检查 | 结果 |
| --- | --- |
| 前端类型 / 全量前端 / 构建 | 通过 / 797/797（新增 6 项任务列表回归） / 通过；原有 Vite 大 chunk 提示保留 |
| ADK runtime boundary | 通过；后端执行源与 shared 协议 diff 为空 |
| 浏览器 | 真实 App + 虚构本地 API；浅色/深色、1680/1280/900/560px、键盘筛选、目录搜索、空页、草稿与新建任务焦点、原任务确认/停止、轮询节点/动画与减少动态效果通过，无横向溢出 |
| 签名 Lake Dev | `scripts/build_lake_desktop.sh --dev --install` 成功；深度签名、上述准确 SHA、dirty=false、后端 hash 和实际进程路径核对通过。原生专员页显示 33 项角色任务，可打开原任务步骤和 Codex 执行信息 |
| 旧记录保护 | 安装前后比对 19 个项目的全部 150 个 Worker，Task/session 身份、状态、执行绑定及运行 ID/状态均未改变；安装前无活动 Worker、频道或 Router |

截图均为虚构展示数据：[浅色](task-list-light.png)、[深色](task-list-dark.png)、[窄窗详情](task-list-narrow-dark.png)、[手机宽度](task-list-mobile-dark.png)。交互证明见 [任务页](task-list-browser-proof.json) 与 [加载动画](loading-motion.json)。原生 Dev 仅只读核对既有任务，没有发送业务 prompt、重试服务器或重新运行模型推理。临时浏览器与 Vite 服务已关闭。

本轮未重跑后端单元/集成、真实模型或旧 Go/race/vet，下方原验证继续保留原 SHA。资源目录检索、第三方 MCP 等既有后端问题按用户要求不在本轮处理。旧任务仍保留原执行 Agent；未加载到进度的历史任务不推断百分比。正式版未安装或重启，草稿 PR 未合并。

## 当前：专员执行卡片按原任务时间排列（2026-11-11）

本轮前端修复与签名 Dev 源码：`9bb1deab7296000e030a7c39b9c54cd97ab32d37`。后端核心保持 `219636df81270129a1a47279e86ee2b29ead33e4`；本节补充前端投影修复，不将下方原后台/真实推理回归标为本轮重跑。见[实施计划](../../../plan/refactor-specialist-execution-timeline-1.md)。

用户看到会话底部连续出现 Lake 原生执行。读取既有任务和实际运行记录后确认：截图中的任务创建于 11 月 5—6 日，真实后端是 native；今天 09:14（Asia/Shanghai）的新任务已由 Codex 完成，实际外部运行 completed，原任务验收 pass。前端将没有可见正文的旧 Worker 分配卡统一追加到最新消息后，造成执行者未切换的误解。

- 将正文与无正文任务卡合并成临时展示序列，使用原 assignedAt / createdAt 排序。旧卡显示原分配时间，不再占用最新回复的位置。
- 分页时不提前补入已加载时间范围之外的旧卡；排队和活动任务仍显示实际执行绑定，出现公开正文后移除其占位。隐藏的内部派单不冒充公开回复。
- Task / Session 身份负责去重，保留同名任务、旧条目缺 taskId、历史折叠及原任务详情入口。分配卡是前端展示项，不伪造消息、SDK 事件或业务证据。旧原生绑定不改为 Codex。

| 本轮检查 | 结果 |
| --- | --- |
| 完整前端 | 791/791，新增 5 项顺序、分页、排队转正文、原身份去重及投影不改写回归 |
| 前端类型与构建 / 后端类型 | 通过 / 通过；原有 Vite 大 chunk 提示保留 |
| 浏览器 | 实际频道组件 + 虚构记录，旧原生卡在历史位置，Codex 最新回复在后；原任务入口、排队卡替换、浅/深色与 620px 窄窗通过，无横向溢出 |
| ADK boundary / 命名 / 命名单测 | 通过 / 0 违规 / 5 项通过 |
| 签名 Lake Dev | 构建安装成功；深度签名、准确 SHA、dirty=false 与后端 hash 核对通过。实际用户频道最新记录显示 Codex / ACP / 已回传，旧原生卡不再追加到其后，聊天框仍为 Codex |
| 旧记录保护 | 安装前后比对全部 149 个 Worker，状态和执行绑定均未变化；未重新调用业务服务器或模型 |

隔离展示截图：[浅色历史顺序](timeline-history-light.png)、[深色窄窗与新任务回传](timeline-history-narrow-dark.png)。截图均为明确标注的虚构展示夹具，实际用户任务仅进行只读核对。临时浏览器与 Vite 服务已关闭。本轮只修改前端，没有重跑后台集成、后台单元、真实模型推理或旧 Go/race/vet；此前结果仍保留原 SHA。正式版未变，PR 保持草稿，未合并。

## 复用本机 Codex 登录与配置（2026-11-10，认证验证保留）

已测试源码与签名 Lake Dev：`219636df81270129a1a47279e86ee2b29ead33e4`。本节按用户后续明确要求，取代历史版本的项目独立 Key 方案。实现与任务状态见[本机登录计划](../../../plan/refactor-codex-local-login-1.md)。

- 直接使用宿主 CODEX_HOME（默认 ~/.codex）的已有登录、默认模型、provider/服务地址与思考参数。删除项目独立 Key 输入和保存入口；不复制 auth.json、不修改本机 config.toml，不调用登录/注销 RPC。Codex 自己读取和续签其登录，符合[官方认证机制](https://learn.chatgpt.com/docs/auth?surface=cli)。
- 通过固定 Codex app-server 的 config/read 和 account/read 读取有效配置与认证状态，再验证 ACP v1；该检查不创建线程或发送业务 prompt。旧 authentication/status 会将内置 openai 当作 gateway，未将其单独作为认证证据。本机首次初始化超过原 15 秒限制，现 initialize 上限 60 秒、整体状态检查 90 秒；实际本机与签名 Dev 已通过。
- profile 升级 schema2 并增加 revision；配置、auth.json 中账号身份或选定 provider 环境凭据变化使原验证失效。同账号正常 token 刷新不改变执行身份；原 Worker/run 不改写或重放。状态读取自动检查当前连接，缺登录时明确要求先在本机 Codex 登录。
- 仍固定 adapter 2.2.2 / engine 0.160.1 和已验证的模型工具目录。目录通过无秘密的私有启动器在 app-server 启动时注入；SQLite 与日志使用 Lake 私有目录。继承的 MCP、hooks 和 notify 同时在启动与线程层关闭。空 MCP 表不会清除继承项，逐个 enabled=false；适配器收到 ACP mcpServers 又会重建表，因此 Lake 私有 MCP 桥与禁用项合并进完整线程配置，ACP mcpServers 留空。桥子进程通过 env -i 启动，不继承 Codex 凭据环境。实际业务工具仍经原 ToolExecutor、审批、任务账本和验收。

| 检查 | 本次结果 |
| --- | --- |
| 后端 TypeScript / Web 类型与构建 | 通过；Vite 原有大 chunk 提示保留 |
| 后端集成 / 后端单元 / 前端 | 192/192；259 通过、4 个既有可选跳过；786/786 |
| 真实固定 Codex + Node 22.22.0 | 3/3，最终串行完整运行；本地 Responses 证明默认模型、provider 与 max 继承、原 Read/work_finish 与验收、会话续接/幂等、原生补丁拒绝、继承 MCP/hook/notify 陷阱未执行；另验证已有 API 登录和实际删除登录文件后的未就绪状态，无推理请求 |
| 用户现有 ChatGPT 登录 | 独立临时 Lake Home，真实 Codex 读取指定测试文件并 work_finish，原任务 completed / acceptance pass，回传测试标记；未填写独立 Key。UI 用合成普通模型配置展示协调菜单，Codex 直接使用实际 ChatGPT 登录，未调用该普通模型做协调推理 |
| Web 与 macOS 原生界面 | 浅/深色、620px 窄窗、键盘模型入口、配置跳转与 Escape 草稿保留通过；设置无密码框或可见原生 select。原生 Pilot 模型保持 gpt-6.1-terra，浮层显示已连接本机 Codex；项目设置显示 ChatGPT 登录、gpt-6.1-sol、max |
| ADK boundary / 命名 / 命名单测 | 通过 / 0 违规 / 5 项通过 |
| Lake Dev 安装与数据 | 签名脚本构建/安装成功；来源 SHA、dirty=false、深度签名、运行进程路径与后端 hash 均核对。当前用户项目 enabled / transportReady / assignmentReady 均为 true，5 位专员默认 Codex；148 个旧 Worker 状态和执行绑定完全不变，原 ACP 验证 Worker 保持 native / paused |

截图均来自隔离测试工作区，仅有指定的本地测试证据：[实际回传](local-login-report-light.png)、[本机登录设置](local-login-settings-light.png)、[深色窄窗](local-login-settings-narrow-dark.png)。本机 config.toml 哈希未变；测试工作区、访问令牌文件及进程均已清理。未访问或重试业务服务器，正式版未安装或重启，PR 未合并。

API 登录检查使用专用 Codex Home 的合成凭据，真实 ChatGPT 登录只用于上述本地只读任务。没有验证 OS Keychain-only 登录的跨进程账号切换、Node 24 下本次新增配置加载流程、macOS 以外平台、Claude Code、图片输入、运行中补充输入、完整 Watchdog 主动指导及独立推理的逐轮计费控制。旧并行压力下工具目录偶发缺少 Read 的问题未定位，本轮串行通过不能证明其已修复。未改 Go 源码，未将旧 Go/race/vet 结果改写为本轮通过。

## Codex 认证缺项与 Pilot 配置入口（历史，已由本机登录替代）

已测试源码与签名 Lake Dev：`7b7ef9fef9c0e2712a1898be1b3e51bf7dd3b932`。本次只补齐就绪原因及配置入口，仍采用项目独立 API Key 认证。

用户启用 Codex 后，实际 Node/npm 自动识别、固定适配器安装和 ACP 握手均已成功；当前阻塞是项目没有独立 API Key。原 Pilot 只得到泛化的“尚未就绪”，且其模型菜单缺少提示所指的 Codex 配置入口，因此重复请求仍无法建单。

- 后端分别报告未启用、当前连接未验证、连接失败、缺少独立 Key 与旧凭据状态需复验；缺 Key 不创建 Task/Worker，也不改变旧任务。
- Pilot 原模型菜单新增“专员 Codex”的具体状态及“配置 Codex”，跳转当前项目 Agent 设置并保留草稿。此入口仅用于配置，Pilot 继续使用原协调模型，不能在此误选为独立 Codex 执行。
- 专员仍可从同一菜单选择独立 Codex。设置页在已启用且 ACP 连接正常时明确显示缺少独立 Key，避免将握手成功当作认证完成。

| 本次检查 | 结果 |
| --- | --- |
| 后端 TypeScript / Web 类型与构建 | 通过 |
| 完整后端集成 / 后端单元 | 191/191；254 通过、4 个原有可选跳过；新增 Pilot 缺 Key 拒绝派发且不建任务回归 |
| 完整前端 | 786/786；新增 Pilot 配置元数据不改变协调模型、无普通模型时保持连接入口回归 |
| 真实 Codex（Node 22.22.0） | 2/2；本地 Responses 夹具和合成凭据，包含无普通模型配置的成功 Worker 路径 |
| ADK boundary / 命名 / 命名单测 | 通过 / 0 违规 / 5 项通过 |
| Web 交互 | Pilot 缺 Key 状态、项目配置跳转及草稿保留、切到专员仍默认 Codex、浅/深色与 620px 窄窗通过，无横向溢出 |
| 签名 Lake Dev | `scripts/build_lake_desktop.sh --dev --install` 成功；来源 SHA、dirty=false、深度签名、进程路径与后端 hash 核验通过 |
| macOS 原生浮层 | Pilot 模型保持 gpt-6.1-terra，浮层显示专员 Codex 缺 Key 及配置按钮；原生跳转到启用状态为 on 的项目 Agent 页，明确显示缺项 |

隔离交互截图：[Pilot 配置入口](readiness-pilot-light.png)、[深色窄窗](readiness-pilot-narrow-dark.png)。截图仅使用独立测试 Home 和合成模型配置，没有用户业务内容或真实凭据。

用户项目当前仍缺独立 Key，本次没有导入其他凭据、执行付费推理或重试真实服务器任务。认证补齐前请求仍会按原准入规则拒绝，不伪造任务或服务器状态。Node 24、签名自动安装及旧 Go 的先前实测保留其原源码 SHA，未将旧结果标为本次重跑。正式版与 PR 合并状态保持不变。

## Codex 与统一模型入口（历史，2026-11-10）

已测试源码与签名 Lake Dev：`98140ef9ce6ffbc7f83f9f75c09baacc37586099`。本节取代下方历史版本中的 runtime-acp、独立分配面板、手工路径及原生默认行为；完整长期路线图仍有未完成项。见[本次实施计划](../../../plan/refactor-codex-composer-1.md)。

- 外部产品目录、设置、工具与新任务入口仅支持 Codex。已删除 runtime-acp 生产启动器及私有模型 RPC，Lake 原生运行仍使用原公开 SDK。退休后端的原 Worker/child、运行记录与 unknown 操作保留，禁止续跑、切换或重放。
- 未保存执行偏好的专员默认 Codex；明确的原生偏好继续有效。聊天框只保留原模型入口，Codex 以 Agent / ACP 标识，与普通模型分组选择。选择普通模型保存原生偏好，选择 Codex 保存 Codex 偏好；浏览分类不改变实际执行者。旧任务维持原快照。
- Codex 发送继续使用原显式新任务准入、角色/连接 CAS 及 requestId 去重，宿主直接派发，不调用 Router 模型。发送后保持 Codex 选择并更换下一次请求 nonce；继续旧任务使用准确任务入口。配置未就绪时保留草稿并打开当前项目 Agent 设置。
- 启用 Codex 会自动识别本机 Node 22.22+ / 24.14+ 及配套 npm，在当前 Home 的私有目录安装缺失或版本不匹配的固定 adapter 2.2.2 / engine 0.160.1，再握手。主 Lake 后端继续使用 Node 24.14.0。路径输入折叠到高级设置；自动识别只检查绝对 PATH、常见安装目录和宿主 Node，不执行 shell 启动脚本或扫描项目。
- 独立 Codex 只需当前项目自己的 API Key。没有普通模型时，原 SDK 仍托管工具和权限，但其 Model 端口拒绝推理；需要普通模型的原生 child 会明确失败。真实 Codex Worker 已在没有普通模型配置的环境完成 Read、work_finish、报告回传及原任务验收。

| 检查 | 本次结果 |
| --- | --- |
| 后端 TypeScript、前端类型与 Web 构建 | 通过；保留原有 Vite 大 chunk 提示 |
| 完整后端集成 | 191/191；含自动准备、精确版本修复、默认 Codex、退休后端历史、原审批/停止/child/幂等与回传验收 |
| 完整前端 | 784/784 |
| 后端单元 | 253 通过，4 个原有可选测试跳过 |
| 真实固定 Codex + Node 22.22.0 | 2/2；独立临时 Home、本地 Responses 夹具、合成凭据 |
| 真实固定 Codex + Node 24.14.0 | 2/2；同一完整用例，分别串行执行 |
| ADK runtime boundary / 命名 / 命名单测 | 通过 / 0 违规 / 5 项通过 |
| 签名桌面 Dev | `scripts/build_lake_desktop.sh --dev --install` 成功；深度签名校验、安装来源与运行中后端 hash 均核对通过，dirty=false |
| 实际 macOS 原生模型浮层 | 专员主入口显示 Codex；原生浮层显示 Codex · Agent 与 ACP 行；配置入口正确返回项目 Agent 页；五位现有专员默认 Codex，页面仅 Codex，路径高级设置默认折叠 |
| 签名 SEA 自动安装与握手 | 全新隔离 Home、PATH 仅系统目录，自动找到 Homebrew Node 22.22.0 与 npm；真实 npm 安装两个精确版本后 ACP 握手成功；未配置普通模型 |

`server.test.cjs` 的宿主生命周期用例使用明确标注的 Codex ACP 协议夹具，不将它当作真实 Codex 推理。真实进程证明另由 `acp.integration.test.cjs` 提供：设置 `LAKE_CODEX_ACP_TEST_ADAPTER` 指向固定安装目录，`LAKE_CODEX_ACP_TEST_NODE` 分别选择 Node 22 / 24，由 Node 24 运行测试。真实固定引擎仍须提供受管理工具目录，原生补丁不能旁路执行，Read 和 work_finish 生成原宿主业务回执；不放宽原工具断言。

隔离 Web 联调通过模型菜单完成 Codex 启用、自动路径、保留草稿、真实 Codex 读取工作区及已验收报告。普通模型与 Codex 互切并重载后持久化，旧 Task 执行绑定保持；浅/深色、620px 窄窗、键盘选择与 Escape 返回入口通过，无横向溢出。macOS Dev 使用实际原生浮层检查 Codex 及配置跳转；普通模型互切的持久化验证在隔离 Web 完成，没有向用户项目发送推理任务。

用户项目原 Codex profile 仍未启用；未导入普通模型或全局 Codex 登录凭据，未使用真实外部 API Key 进行付费推理。使用时在聊天框模型菜单进入“配置 Codex”，填写独立凭据并启用。旧 ACP 只读验证 Task 保持原生绑定与暂停状态。正式版未安装或重启，PR 未合并。

本次没有 Go 源码变化，未重跑旧 Go/race/vet；下方原 Web 整包超时继续作为历史结果保留。历史并行压力下 Codex 工具目录缺少 Read 的一次失败仍未定位，本轮两种 Node 的最终串行用例均通过，不能据此宣称高负载问题已修复。macOS 以外平台、Claude Code、图片输入、运行中补充输入、完整 Watchdog 主动指导及独立推理的逐轮计费控制仍未开放。

## 首批 ACP 执行后端兼容记录（历史）

2026-11-10，macOS arm64，Node 24.14.0。用户已授权先接入 runtime-acp 与 Codex。本记录区分协议贯通、宿主业务回执和模型服务认证；未使用真实外部 API Key 进行付费推理。

| 项目 | runtime-acp | Codex |
| --- | --- | --- |
| Agent / 适配器 | 固定 SDK v3.17.2 的公开 AgentRuntime，Lake 薄 ACP 宿主 | `@agentclientprotocol/codex-acp@2.2.2` / `@openai/codex@0.160.1` |
| 模型与认证 | 复用 Lake 当前 Model 公开端口；密钥不进入子进程 | 项目独立 API Key、独立 Home；不读取用户全局 Codex 登录或 Pilot 密钥 |
| ACP | 稳定 v1 stdio；initialize/new/prompt/cancel/load | 真实固定版进程稳定 v1；实际 MCP 调用和报告返回已测试 |
| 整 Worker / ACP child / 外部执行段 | 三种入口以及 ACP Worker→ACP child 均有真实 SDK/HTTP 集成测试 | 共用宿主绑定和工具执行路径；真实 Codex→MCP 桥→宿主工具→结果已通过隔离夹具 |
| 工具边界 | 仅代理注册表，不提供本地执行端口；SDK bootstrap 不能替换成原始 built-in | 固定静态模型目录禁用 Shell、apply_patch、图像读取、搜索、原生子代理与 REPL；仅本轮私有 MCP 工具和 MCP 资源查询入口 |
| 审批 | 原 ToolExecutor / ManualPermissionBroker，写入批准前无落盘 | 已关联本轮 Lake MCP tool_call 的 transport permission 只准许进入桥；业务操作仍必须通过原 ToolExecutor 和 Broker |
| 继续会话 | 仅同项目/任务/Worker/generation/scope/profile revision 下明确 completed 的 session/load | 实现相同门禁；真实服务认证与多轮恢复仍需用户实际账户验证 |
| 运行中补充输入 | 私有 ACP 扩展转发公开 steerTurn | 暂不声明支持；拒绝当前 turn 的即时交付，不伪造 queued/steered |
| 停止/重启 | 真实待批准写入测试：停止后无文件，sent 保留 unknown，重启不重放 | 同一进程树与 IPC 撤销路径；真实进程正常退出/回收已测试 |
| Windows/Linux | 本批未验证 | Windows/Linux 执行拒绝，首批仅开放已验证的 macOS |

### 证据与当前限制

- `runtime/typescript/server.test.cjs` 覆盖三种宿主入口、ACP Worker 的子任务、真实 Read/Write 回执、原审批、停止、无重放、配置 CAS、凭据独立与角色快照。`externalRunId/externalSessionId` 只由宿主加入真实 Operation；外部报告没有业务 operation_id。
- `runtime/typescript/acp.integration.test.cjs` 是显式启用的真实 Codex 集成。固定 npm 包放入独立临时 Home，使用本地 Responses 协议夹具与合成凭据，捕获真实请求工具目录并确认没有原生执行工具，验证私有 MCP 只执行一次宿主 Read、返回输出及重复 requestKey 不重复执行。运行：`LAKE_CODEX_ACP_TEST_ADAPTER=/absolute/path/to/pinned-install <Node24> --test runtime/typescript/acp.integration.test.cjs`。普通测试不联网安装、不使用真实账户。
- Codex 静态模型元数据来源于 [OpenAI 固定版本目录](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/models-manager/models.json)，首批固定 `gpt-6.1-sol`，保留原模型指令和上下文信息，只限制本地工具能力。静态目录通过独立 `config.toml` 在 app-server 启动时读取；只传线程 config 无效，不能替代该设置。
- 认证文件用私有目录逐层校验和原子替换；固定依赖在本机操作者显式安装后使用。包安装使用 npm integrity 和精确的 adapter/engine 版本；项目不自动更新适配器，不接受模型指定可执行文件。
- 并发最多 4 个外部运行（父等待 child 仍计入），满额返回 busy，不进入互等；每个调用最多 15 分钟且不超过原任务 deadline。尚未实现计划的计算槽让渡与独立 8 进程容量。
- Codex 的推理直接由独立引擎调用其模型服务，Lake 不伪造它的 token/模型轮数；当前强制工具权限、租约、配置变更、截止时间、输出上限和进程回收。独立推理的逐轮计费预算、Watchdog 主动指导与完整输入交付审计仍属后续项。
- 只开放固定适配器的受管理工具路径；ACP 权限本身不是沙箱。首批只接收文本说明和报告，图片附件及跨任务文件注入未开放。自定义 Agent、Claude Code、任意 CLI、任意联网模型服务配置和无人值守发布均未因本批接入而启用。

### 本地验证

源码 `f75c5dde6ce4a58eea980d5a3d83137c68a14835`：TypeScript 类型检查、Web 构建、后端 184 项集成测试、前端 774 项测试、后端单元 251 项通过（4 项现有可选测试跳过）、ADK runtime boundary 与命名检查通过。macOS arm64 已经 `scripts/build_lake_desktop.sh --dev --install` 构建/签名/安装，build-origin 记录此 SHA 且 dirty=false；在 Lake Dev 实际打开 Agent 页并通过签名 SEA 子进程的 ACP 握手，没有启用既有项目的后端或改动模型凭据。

Web 设置页已用独立 Home 实际验证连接测试、专员 AppSelect、键盘焦点、浅/深色及窄窗；输入区域没有横向溢出。截图：[浅色](settings-light.png)、[深色](settings-dark.png)、[下拉选择与键盘焦点](settings-select.png)。

Go 补充回归：`go test -race ./internal/ai ./internal/web` 中 AI 包通过（550.995s）；Web 整包在默认全局 10 分钟上限处超时，未计为通过。超时时正在执行的 `TestSREVerifierKeepsFullLoopAndExactAcceptanceEvidence` 单独复验通过（18.113s）；`go vet ./internal/ai ./internal/web` 通过。本批没有修改 Go AI/Web 源码，没有放宽或跳过该测试。

后续修正将 session/load 的重放事件排除在本轮报告之外，并在执行结束时撤销工具信号；真实 Codex load/resume 已复验，旧工具不重放、旧报告不重复累计。

运行桥生命周期修正源码 SHA：`70b883538dab06866643efc7c3121faf84758533`。真实 Codex 固定版已复验握手、无原生工具、伪造补丁拒绝、MCP Read、requestKey 去重与 session/load 重放隔离；后端 ACP 重点用例 9 项复验通过。

最终 Dev 安装与复验源码：`0cd7e116f087db33b7a437dc5c94afa200b626d6`（相对 70b88353 仅有文档变化）。签名与 build-origin 核对通过，dirty=false；最终完整后端集成测试 184/184 再次通过。Dev 窗口重新打开正常，原生与既有任务未切换后端。

## 专员显式分配与执行回传（2026-11-10）

本批源码与实际 Dev 安装：`b508be56dda27866c2283045a661cfadf7dcd473`。这是前述首批后端的交互与接单补充，具体任务见 [实施计划](../../../plan/feature-specialist-agent-assignment-1.md)。

- 专员输入区提供普通对话及分配新任务给 Lake Worker / runtime-acp / Codex。显式分配由认证后的宿主直接创建原 Task/Worker，不调用 Router 模型猜测执行者；职责版本、连接版本和准确频道在接单时校验。相同 requestId/输入读取原回执，冲突输入拒绝，重启与重复点击不重放外部 prompt。
- 独立分配不改专员默认配置；新 Worker 冻结执行后端，已有任务不切换。未启用、未安装、缺少独立凭据或未通过当前 ACP 握手时，不写用户消息或任务，草稿保留，可跳到当前项目的 Agent 设置。连接测试不证明推理认证可用。
- 频道和详情按准确 project/task/worker/session 读取实际外部运行，显示执行者、派发、审批、已回传、失败与结果未知。没有运行记录不显示已调用；报告不产生业务 Operation 或独立验收。逻辑 ACP child 显示实际执行 Agent，原生 child 委派外部段保留原 child 身份。
- 整个 ACP Worker 的实际宿主调用使用独立 `acp_turn_` 身份聚合进度与最终报告；不伪造 SDK 事件。已验证同一执行只形成一条频道回复，原始记录与业务回执保留。
- 外部产品显示名集中在共享目录，命名检查仍只允许该准确常量行，不泛化允许旧后端名称出现在业务实现或正文中；新增命名边界回归通过。

| 检查 | 结果 |
| --- | --- |
| 后端 TypeScript、前端类型及 Web 构建 | 通过；Vite 保留已有大 chunk 提示 |
| 完整后端集成（提交后复验） | 188/188 |
| 完整前端（提交后复验） | 779/779 |
| 后端单元 | 251 通过，4 个现有可选测试跳过 |
| 真实 Codex 进程 | 2/2；固定 adapter 2.2.2 / engine 0.160.1，独立临时 Home、本地 Responses 夹具与合成凭据 |
| 命名与命名边界单测、ADK runtime boundary | 通过；命名单测 5 项 |
| 签名 Lake Dev | `scripts/build_lake_desktop.sh --dev --install` 成功；签名核验通过，build-origin 为上述 SHA、dirty=false |
| Lake Dev 实际界面与签名 SEA 握手 | 专员分配、Codex 未就绪提示、协调模型标签可见；runtime-acp 握手成功，既有两个外部 profile 均保持未启用 |

隔离 Web 联调通过键盘直接分配 runtime-acp，实际独立进程读取项目目录、提交原 work_finish 并回到频道；配置跳转保留输入，执行报告可展开并查看原任务。浅/深色、620px 窄窗、焦点与 Escape 返回入口实际检查，无横向溢出。截图：[浅色回传](assignment-light.png)、[深色](assignment-dark.png)、[窄窗口与未就绪提示](assignment-narrow-dark.png)、[窄窗口菜单](assignment-menu-narrow-dark.png)。

本批未使用用户的真实 Codex 推理凭据执行任务，未启用用户项目的外部后端，也未修改正式版。Codex 测试曾在并行完整回归期间遇到一次请求目录未包含 Read 的失败，原因尚未定位；未放宽工具断言，原用例单独复验及最终两项串行复验均通过，高负载初始化稳定性继续观察。未提供真实工具回执时，原任务不能被报告验收成功。

本批没有 Go 源码变化；上述 Go 补充结果属于前批记录，没有把旧 Web 整包超时改写为通过。原 ACP 首批的并发、平台、认证、附件、Claude Code 与主动指导限制继续适用。
