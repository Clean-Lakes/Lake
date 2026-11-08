# TypeScript 后端切换审计（2026-11-07）

**结论：尚未完整切换。** 当前 Lake Dev 已接通对话、Pilot/专员、受控通用工具和部分资产等主链路，但仍有配置未迁移、可见入口未实现、成功状态与实际结果不符，以及完整旧数据/平台验收缺口。不能用“应用能启动”“现有测试全绿”或“SDK 自带工具”代表功能等价。

本次只审计和记录，没有修复下面全部问题。上一轮通过正常设置 API 恢复当前项目既有 MCP 继承关系，只解决该项目当时的空目录，不代表通用迁移器已经补齐。

## 审计对象与方法

- 检查源码 `ee4570b4649fe57a9c5cbd3dab41c8d05888740e`；当前 develop 基线 `72b0b018233c9f3acb24de251264462981f70d1d`。源码包含尚未合并的 PR #197。
- 当前已安装 Lake Dev 源码 `878f9f6657a3b82c6aa653afd329f3687ce18e63`，与检查源码只差验证文档；来源 dirty=false，后端 SHA-256 `da4b6e549fb93707b246b60ae8d1af189bd1ab894db0c2985371d46a6d964ba4`。本审计没有重新安装或改变生产应用。
- 对照前端清单的 **128 个 API 函数**、20 个迁移领域、SDK 的 44 个内置工具、TS 路由和迁移器、旧 Dev 数据及当前 Dev 的只读状态。
- 当前 Dev 执行 **25 个只读接口探测**；同一候选 bundle 在独立临时 Home、随机 loopback 端口执行 **36 个接口场景**。后者没有调用模型、连接业务服务或产生业务 Operation。
- 另建独立审计项目进行真实模型的记忆对照，使用合成内容。没有修改原业务项目或全局的记忆开关。一个前台记忆请求触发 Write 待确认，未批准，仅停止该审计会话。验证结束后关闭该审计项目的积累与使用，保留测试来源供复核。
- 当前用户业务的 SSH、数据库写入、发布、定时任务及生产客户端未作破坏性端到端测试；不把未测项写成成功或故障。机器可读证据见[结果附件](cutover-audit-2026-11-07.json)。

`128` 是前端 API **函数数量**，不是“128 条路径均已端到端通过”；动态 `aiOperation` 等函数包含多个动作，另有自然记忆等独立客户端。它们通过路由源码、调用点与针对性探测补充检查。完整等价矩阵仍是 48 个函数有候选证据、0 个取得全量等价签字；**0 不表示当前没有可用功能**，但 `cutoverAllowed=false` 和门禁退出 1 是正确状态，不能豁免。

## 需要优先处理的发现

| 编号 | 优先级 | 发现与实际影响 | 证据与边界 |
| --- | --- | --- | --- |
| A01 | P1 | 旧项目的 MCP 继承/绑定授权没有完整增量迁移。全局设置可以测试成功，专员目录仍可为空。 | 原授权账本中当前项目继承为 true，TS 原来无该记录。现已按原设置恢复，项目可见 zmy/GOS，zmy 真实初始化与 tools/list 返回 19 个工具。通用导入仍只保留项目策略等选定记录，未导入 MCP inheritance/bindings authority。 |
| A02 | P1 | **自动长期记忆未证实有效产出**：后台 completed 与已发布笔记不是同一件事。 | 审计前 21 个原生提取任务 completed，9 个 scope 的 publishedRevision 均为 0，成品目录没有 Markdown。隔离项目的显式合成长期规则提取 completed、调用 2 次模型，仍为 0 条笔记；再用长期写作偏好对照，completed 后原手工笔记版本/数量不变。**手动保存产生文件和 revision=1，独立新 Session 准确回答合成规则，并记录 1 个合格来源**。原因待定位，不能据此断言所有输入都无法自动提取，也不能宣称自动记忆已验收。 |
| A03 | P1 | 图片、附件和结构化引用入口未接完整。 | 图片/非空 references 发送直接 501；原文件上传使用 octet-stream，却被全局 JSON 请求解析拒绝为 415；text-files POST 返回 Session 对象，未返回附件。消息入口也未传递 resourceIds/mentions 给 send，引用的显示与执行边界需要联合修复。 |
| A04 | P1 | Plan 按钮及计划查看/执行 API 没接上。 | plans GET、mode POST、executePlan POST 均实测 501。SDK 的 EnterPlanMode/ExitPlanMode 工具与任务账本的 Plan 约束存在，不代表界面入口已经等价。 |
| A05 | P1 | 用户消息队列与上下文管理动作未接。 | message-queue GET 固定空列表、POST 501；compact、rollback、undoFile、clear、clearReferences、extractPreset 均 501。Super-agent 的内部输入事件/任务排队已经实现，不能与用户可编辑的消息队列混为一谈。 |
| A06 | P1 | 资源目录可读，但新增/移动文件夹、导入及删除恢复链路不完整。 | resource-tree、导入预览/提交、navigation-delete 和 SSH 密钥选择接口 404；navigation-trash GET/POST 固定空 items。旧目录展示不代表目录编辑已经迁移。新建 SSH 的通用分支也没有保存请求中的 parentId，需补父目录绑定验证。 |
| A07 | P1 | 11 个原来可用的活动资源，在 TS 中仍不可执行。 | 5 个旧本机、4 个 PostgreSQL、Redis/Kubernetes 各 1 个由 available 变成 unavailable；SSH 123 个、MySQL 5 个已增量迁入。新 PostgreSQL/Redis/APISIX/指标服务的保存和连通性探测已存在，但不能等同于旧连接导入及 Agent 查询/管理适配。可经授权 SSH 使用远端 CLI，不代表所有直接资源适配齐全。 |
| A08 | P1 | 工作流、定时和外部守候主线未迁完，读取会伪装成空目录。 | 当前业务项目旧 DB 有 1 个保存的 workflow，TS workflows 返回 templates=[]；保存/运行和 schedule PATCH 501。调度与授权不能通过自动重放旧任务补齐。 |
| A09 | P1 | 多个接口“200 成功”，却返回空结果或错误对象。 | preset 保存后仍为空、删除返回空数组；text-files 和旧 SRE 详情/导出返回 Session；旧模型测试接口在目标为不可达 loopback 端口时仍返回当前 ModelSettings；恢复接口固定空列表。必须收紧路由匹配和响应合同，不能只检查 HTTP 状态。当前模型设置页调用的 provider test **确实会发起请求**，不要把旧 testModelSettings 的问题泛化成所有连接测试都是假成功。 |
| A10 | P1 | 安全恢复和未决操作的用户处理入口不完整。 | 当前 guard、许可版本、审批和 unknown 不重放已有实现/回归，但 resolveOperation 为 501，完整旧 grants/recovery/authority 迁移和 UI/CLI 路径没有等价证据。保留关闭/需核实状态是正确边界；不能靠清账本、打开开关或重跑来修复入口。 |
| A11 | P2 | 模型能力设置与协议覆盖不足。 | 自动能力探测 501；reasoning GET/POST 均固定 supported=false，运行时 reasoningLevel 固定 disabled。Gemini/Ollama 协议会落入 OpenAI Chat 分支，未见专用映射；当前 4 个供应商使用的是已识别的 openai/openai-response/claude，没有实测这些未配置协议。当前供应商 ID、模型能力现值和凭据引用保留，未发现本机现有目录的能力字段丢失。 |
| A12 | P2 | SDK 的完整宿主能力尚未接全。 | 当前能力目录共 44 个内置工具：20 connected、WebSearch 1 个依模型、23 requires_host_service；后者包含 Cron、工作流、浏览器 js、归档阅读等。Lake 自己的 MCP/任务工具另计。部分上游协调工具未必应原样暴露，但不能称“所有 SDK 功能已经接入”。 |
| A13 | P2 | 旧 Memory、SRE/规范证据与部分历史协议仍为保留/替换状态。 | 新分层记忆 API/设置存在；旧 memory URL 404、旧 settings 固定关闭，旧正文/同意不自动导入属于已记录的架构边界，不能自动翻开。旧 Go 会话只读不重放符合要求；完整旧任务查询、证据导出及恢复接口尚未迁移。需要显式迁移/兼容或清晰退役入口，而非删除旧数据。 |
| A14 | P2 | Watchdog 与平台/CLI 的完整等价尚未交付。 | TS 有 15 秒 heartbeat、45 秒租约、重启撤销 owner 和保留 unknown；未发现 Go CheckSuperagentProgress 那套有界派发失败、孤儿/排队状态核对的完整对等接入。不能把 heartbeat 当完整 Watchdog。当前 TS CLI 仅 web，终端 Agent 接管/交接明确未接；macOS 本机执行有平台 guard，Windows/Linux 本机凭据隔离执行及持续终端未完成原生验收。 |

源码定位使用上述审计 SHA：

- [MCP binding 与空目录投影](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/extensions.ts#L218)、[迁移读取白名单](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/migration.ts#L11)。
- [记忆只在 changed 时发布，随后标 completed](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/memory.ts#L1491)、[记忆模型阶段与提示](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/agent.ts#L459)。
- [请求体只接受 JSON](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/server.ts#L76)、[附件/消息入口和队列](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/server.ts#L591)、[会话默认分支](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/server.ts#L647)。
- [工作流/日程空壳](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/server.ts#L491)、[已删除/预设空壳](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/server.ts#L658)、[能力目录](https://github.com/Clean-Lakes/Lake/blob/ee4570b4649fe57a9c5cbd3dab41c8d05888740e/runtime/typescript/capabilities.ts#L50)。

## 20 个领域的逐项结论

“候选已接”仅代表本次所列路径和现有回归有证据，不提升为全量等价验收。

| 迁移领域 | 本次结论 |
| --- | --- |
| 对话、工具、审批、停止 | 候选主链路已接；135 项运行时测试含真实 SDK 错误、受控读写、审批/取消、子智能体及独立停止；附件/旧动作另有缺口。 |
| 会话历史、重连 | 新 TS 持久化和重启有回归；旧 Go 只读档案保留，完整旧任务/evidence API 未迁。 |
| 导航、标签、图标 | 会话导航/标签已接；资源树编辑、删除/恢复不同，见 A06/A09。 |
| 模型协议和设置 | 当前供应商/选中模型可用；能力探测、reasoning、其他协议仍缺，见 A11。 |
| 附件、图片、引用、光标 | 编辑器 UI 不等于后端收件成功；A03 为实际失败。未复验所有原生输入法/光标边界。 |
| 资产目录、文件夹、导入 | 原目录大部保留；编辑、HexHub 导入及恢复缺失。 |
| SSH、信任、终端、接管/恢复 | SSH 配置与指纹、受控 Bash、手动终端已有；密钥选择、Agent 终端接管/交接和全量恢复未齐。 |
| DB、Redis、Docker、Kubernetes、服务 | MySQL 与服务连通性探测有候选证据；旧 PG/Redis/K8s 等连接及直接业务适配未齐。 |
| Pilot、长期专员、频道 | 真实 Task/Worker、频道、报告、独立停止/并发已有；旧 pilot/sre API 固定关闭，不代表新 Pilot 没开启。 |
| 目标、尝试、验收、证据 | 新账本及实际回执验收已有回归；显式计划 UI、旧证据导出及全量映射未齐。 |
| 安全、范围、撤销、unknown | guard 与不重放生效；完整 grants/recovery/旧 authority 接口缺口保留。 |
| 工作流、日程、外部事件 | 尚未完整接入；空列表不是旧项目没有工作流的证据。 |
| 记忆同意、文件、提取、召回、遗忘 | 新手动发布/独立召回实测成功；自动产出未证实；旧记忆有意不自动导入。 |
| Skills、MCP、插件 | MCP 真实目录可连；当前项目继承已恢复，通用迁移未补；当前 Skills 目录为空。未把其他客户端已连接插件当作 Lake 的实际能力。 |
| 队列、补充、压缩、回退 | Super-agent 事件接纳/续问已有；用户队列、手动压缩/回退/清理等旧入口未接。 |
| 既有数据迁移、回退 | 项目/专员/频道/大部资源和只读历史保留；11 个旧可用资源、MCP 继承、工作流/旧知识仍有缺口。原数据库保留。 |
| CLI、stdio、Magpie | TS 入口只支持 web；完整原 CLI/stdin/Magpie 合同未验收。 |
| macOS 桌面、更新、Dev 隔离 | 当前签名 Dev 可运行；签名和 19 项 Dev 脚本通过。正式版更新/安装没有执行，不用 Dev 证据替代发布验收。 |
| Windows 桌面、安装、更新 | 未做本次原生实机测试，平台执行器也有明确缺口，不能标完成。 |
| 明暗、窄窗口、Lake Dev UI | 复用同功能源码的前轮原生主题/窄窗证据，726 项前端回归通过；可见按钮对应的后端合同问题另列，未重做所有页面原生验收。 |

## 复核结果与局限

本次重新运行：128 项 API 清单校验、TS/前端类型检查、135/135 服务端回归、121 个源测试通过（3 个既有外部 Claude-Mem 集成跳过）、726/726 前端回归、19/19 Dev 脚本测试、命名边界、ADK 边界，以及已安装 App 的深度签名检查。完整等价门禁预期退出 1，保持 BLOCKED。

36 个隔离探测中，6 个 404、19 个 501、1 个 415、10 个 200。**10 个 200 不计为通过**：其中多项无实际效果、合同对象错误或明确不支持。探测结果是缺口复现证据，不新增“应当返回空壳”的测试来固化错误实现。未将真实任务或旧未决操作用于制造失败。

记忆真实模型探测记录只证明这两个输入没有发布新内容，不能替代质量集。第二个偏好请求前台曾提议普通 Write，未批准并单独停止；随后该来源后台提取仍 completed 而未更新笔记。当前实测不能定位到底是提示、文件工具、模型行为还是发布前候选收集问题。后续修复须证明实际文件、来源、索引、独立会话读取和遗忘闭环，而非只修改状态文案。

历史文档中的 118 项接口、603 项前端测试和若干 pending 描述反映旧阶段，不能当成本轮现状；本报告与 JSON 记录当前证据。`parity.json` 未被改成 verified，测试全绿与完整等价两者继续区分。

## 修复顺序

1. 先消除伪成功和错误类型兜底，对当前 UI 尚不可用的动作提供真实能力状态；恢复 MCP 配置迁移与结构化资源引用合同，并定位自动记忆没有成品的问题。
2. 补齐附件、Plan、队列/上下文、目录编辑/导入/恢复及原可用资源适配；同时覆盖真实前端请求、持久化和重启，不只测单个工具方法。
3. 分批完成工作流/日程/Watchdog、完整安全恢复、旧证据与知识迁移、CLI 和各平台验收。保持原授权、权限及 unknown 状态，不复制生产凭据或通过重放补数据。
4. 按最终集成 SHA 对完整合同验收后再更新等价矩阵。审计报告、普通 PR 合并和 Dev 试用均不授权生产切换或发布。
