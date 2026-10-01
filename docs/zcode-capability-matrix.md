# ZCode → Lake 能力矩阵

基线：ZCode [`29628c9acdb81b703bbd4080c207a0e7ce5e276e`](https://github.com/zai-org/ZCode/tree/29628c9acdb81b703bbd4080c207a0e7ce5e276e)，Lake 工作区 2026-10-01。实施目标与任务编号见[迁移方案](../plan/architecture-zcode-lake-1.md)。本表记录能力差距，不代表逐文件移植。Lake 保持 Go/Eino 单运行时；ZCode 的 `subagent` 对应 Lake 的“专员”。

状态定义：**已覆盖**表示 Lake 已有可用入口；**待建**表示方案已安排但尚未按验收项完成；**明确排除**表示本轮不迁移。已有能力的扩展仍单列为待建，以免把部分覆盖误记为完成。

| 能力 | Lake 现状 | 目标与版本 | 状态 | 验收用例 | ZCode 来源 |
| --- | --- | --- | --- | --- | --- |
| 湖、资源、凭据与湖志 | SQLite 运维数据、秘密文件、SSH 最终审批已运行 | 保持原有边界；Phase 6 回归 | 已覆盖 | 旧湖/资源/湖志可读，密钥不进入日志或模型 | Lake 自有能力 |
| SSH 专员 | `lake_ssh_agent`、会话复用、逐次授权 | 接入通用专员接口，旧调用事件兼容；R2 | 已覆盖 | 旧 SSH 检查/命令行为不变，委派链可恢复 | `apps/zcode-cli/packages/core/src/subagent/` |
| 代码专员 | 本地项目文件/搜索/精确编辑/命令工具 | 接入通用专员接口，保留审批；R2 | 已覆盖 | 旧代码请求和 `SpecialistCall` 可读 | `apps/zcode-cli/packages/core/src/subagent/` |
| 会话保存 | 旧 `conversation_turn` 与版本化事件双写，桌面按事件序号恢复；审批和工具事件保留安全字段 | 版本化 user/assistant/tool/approval 事件；R1 | 已覆盖 | 重启后按序恢复工具事件，旧会话无损 | `apps/zcode-cli/packages/core/src/agent/` |
| 长上下文压缩 | Token 预算与模型摘要已接入，保留最近 8 条消息和来源事件序号 | Token 预算、摘要与来源追踪；R1 | 已覆盖 | 200 轮会话不超输入预算 | `apps/zcode-cli/packages/core/src/compact/` |
| 跨会话记忆 | 默认关闭；显式“记住”提取非敏感事实，按湖/项目隔离，CLI 与桌面可查删停用 | 默认关闭，按湖/项目隔离且可删除；R1 | 已覆盖 | 关闭时不提取，开启后可查删 | `apps/zcode-cli/packages/core/src/memory/` |
| 工具注册表 | 内外层工具统一装配，按 ToolSpec 校验名称与 JSON schema，并限制输出、超时和可见性 | ToolSpec、发现、schema、输出预算与超时；R1 | 已覆盖 | 重名拒绝，范围过滤，超限裁剪 | `apps/zcode-cli/packages/core/src/tool/` |
| 统一权限裁决 | Agent 工具按能力和会话范围裁决；代码、MCP、工作流逐次审批并记录摘要；SSH 服务二次校验；Kubernetes/数据库只读执行限于冻结资源 | 工具能力和执行范围统一判定，SSH 再校验；R1 | 已覆盖 | 未授权写入/外部调用均拒绝且审计 | `apps/zcode-cli/packages/core/src/permission/` |
| 代码检查点 | 最多 8 个文件批量预览与应用、私有检查点、批准恢复；应用前复核全部文件，提交失败时回滚已写文件 | 多文件差异、检查点与批准恢复；R1 | 已覆盖 | 预览与实际文件匹配，恢复需批准 | `apps/zcode-cli/packages/core/src/tool/` |
| 模型协议 | Anthropic Messages、OpenAI Chat Completions 和 OpenAI Responses 均已接入 Eino，支持文本、工具调用、SSE 流与用量；旧配置按 Anthropic 读取 | 增加 OpenAI Chat 和 Responses；R1 | 已覆盖 | 三协议文本/工具/流式/用量通过模拟服务 | `apps/zcode-cli/packages/adapters/src/model/` |
| Web 搜索与文档读取 | 图片输入已用；可选 SearXNG 搜索、域名白名单抓取和项目内有界 PDF 文本读取已接入 | 可选搜索/抓取与有界 PDF 文本；R1 | 已覆盖 | 未配置时不暴露搜索，输出受限 | `apps/zcode-cli/packages/core/src/tool/` |
| MCP 客户端 | 官方 Go SDK v1.7.0 已支持 `2026-07-28` 与旧协议协商；stdio、Streamable HTTP、工具发现/调用/关闭、设置入口和逐次审批已接入；配置只存凭据引用，连接时读取私有文件 | stdio 与 Streamable HTTP；R2 | 已覆盖 | 假服务器可发现/调用/断开，密钥不外泄 | `apps/zcode-cli/packages/adapters/src/mcp/` |
| Skills | 用户级和项目级目录可发现并解析 front matter；CLI 可列出/查看，对话显式加载后才加入上下文；内容哈希变化后不自动恢复 | 发现、显式加载与路径校验；R2 | 已覆盖 | Skill 文本不授予工具权限 | `apps/zcode-cli/packages/adapters/src/skills/` |
| 插件管理 | 插件清单、SHA-256 校验、私有目录安装与启停已接入；启用插件的 Skill 可显式加载 | 显式安装、校验和启停；R2 | 已覆盖 | 改动安装文件后拒绝启用 | `apps/zcode-cli/packages/adapters/src/plugins/` |
| 工作区 Hooks | 七类事件已接入，默认关闭、逐次审批、摘要变化失效；执行限时限量且只继承必要环境变量 | 七类受控 Hook 事件；R2 | 已覆盖 | 声明或命令变化使许可失效 | `apps/zcode-cli/packages/adapters/src/plugins/` |
| 桌面扩展状态与权限 | 设置页显示 MCP、Skill、插件和当前项目 Hook 的状态/摘要；插件与 Hook 可显式启停，WebView 桥接只返回白名单字段，密钥经本机 CLI 输入 | 扩展状态/权限面板与凭据隔离；R2 | 已覆盖 | 桥接响应不含 API Key、SSH 私钥和 MCP 授权头 | `apps/zcode-cli/packages/adapters/src/plugins/` |
| 插件 MCP/Hook 声明运行 | 已启用且摘要有效的插件装配 MCP 和七类 Hook；声明 assets、私有安装、独立 MCP 凭据名，逐次审批；停用/篡改阻断旧会话 | 受控装配到扩展运行时；R2 | 已覆盖 | MCP/Hook 实际运行与拒绝/禁用测试通过 | `apps/zcode-cli/packages/adapters/src/plugins/` |
| 通用专员 | Go/Eino 内置与自定义专员共享运行器；CLI/桌面注册、启停、独立模型、白名单、轮数与父范围交集；聊天和 v2 实际调用，v13 表保存元数据与摘要 | 可配置模型/工具/范围，任务持久化；R2 | 已覆盖 | 不能越过父任务权限，结果交回主 Agent | `apps/zcode-cli/packages/core/src/subagent/` |
| 专员检查点恢复 | 私有 0700/0600 执行检查点在模型/工具边界保存；CLI/桌面恢复，工作流按节点/扇出项复用已完成结果，文件锁防并发 | 内部执行恢复；R2 | 已覆盖（新任务） | 重启后不重复完成工具；未知写默认阻断；配置漂移拒绝；旧任务元数据不足时不提供恢复 | `apps/zcode-cli/packages/core/src/subagent/` |
| 动态工作流 | v1 继续运行；v2 JSON/YAML 编译、持久执行；CLI/Agent/桌面可编辑、校验、预演、保存修订、运行、查看节点/事件和恢复 | 类型化 v2、条件/扇出/恢复；R2 | 已覆盖 | 未知写状态不自动重放，预演无执行副作用 | `apps/zcode-cli/packages/dynamic-workflow/` |
| 调度器 | v15 计划/租约/运行/精确授权表，一次性与 cron、事务认领、过期暂停、失败退避、macOS 签名 LaunchAgent 安装命令已接入 | 一次性/cron、原子认领、LaunchAgent；R2 | 已覆盖（未安装用户服务） | 无授权写节点等待审批，未知或失败写计划不自动重放 | `apps/zcode-cli/packages/core/src/` |
| 脚本与关系入口 | CLI/Agent 可列、读、审核运行脚本并查询 link；脚本由 SSH 标准输入传输，v2 `lake_script_run` 固定脚本 ID/目标/哈希 | CLI/工具可列、读、审核运行脚本；R2 | 已覆盖 | 内容哈希变化阻断运行，审批与湖志沿用 SSH 服务 | Lake 自有能力 |
| Web 与 TUI | 只读 Web 和文字优先 TUI 共用版本化会话 API；Web 断线按序号补取，TUI 用方向键切换并显示消息、工具、待审批和工作流状态 | 共享事件协议、本机 Web 和 TUI；R3 | 已覆盖 | 两入口只查看，不在只读入口审批或执行；TUI 经进程内 HTTP Handler，无额外监听 | `packages/server/`、`apps/zcode-cli/packages/tui/` |
| 显式浏览器会话 | 允许域名内的有界 HTML/文本页面读取，最多 4 个显式会话；打开和导航逐次审批 | 浏览器会话适配；R3 | 已覆盖（文本页面） | 页面内容标记不可信；无脚本、Cookie 或 SSH 凭据共享 | `apps/zcode-cli/packages/core/src/tool/` |
| Git/终端/文件树 | 桌面代码工作台展示项目内文件树、文本预览、Git 状态/提交图/差异；按项目 ID 绑定的受控终端逐条命令审批，显示本机执行主体和固定根目录 | 桌面工作台和受控终端；R3 | 已覆盖 | 敏感路径过滤；会话关闭中止命令；命令哈希记入湖志 | `apps/zcode-cli/packages/` |
| 远程代码工作区 | v16 独立 `code_workspace` 授权、规范远端根目录和会话绑定；CLI、桌面、代码专员共享 Go/SSH 传输，提供有界文件读写与逐次审批的命令执行 | 显式绑定远端项目根目录；R3 | 已覆盖 | 运维主机授权不扩展为代码编辑授权；摘要条件写入；断线写入/命令为未知且不自动重试 | `apps/zcode-cli/packages/` |
| PDF/视频附件工作台 | macOS PDFKit 提取 PDF 首页 JPEG 与最多 12 KiB 提交文本；AVFoundation 提取最多 4 张、最长边 768 像素的 JPEG 视频关键帧；桌面发送后两入口均可回看/下载预览，专员和工作流结果摘要可下载 JSON，Web 展示工作流时间线 | PDF/视频预览与有界视频帧提取；R3 | 已覆盖（派生预览） | 原视频/PDF 文件不进数据库或模型；只保存有界派生预览；运行位置、待审批和模型状态可见 | `apps/zcode-cli/packages/` |
| Z.ai 账号、订阅、遥测、云分享 | Lake 无此服务 | 保持本地单用户产品边界 | 明确排除 | 不出现云账号或计费依赖 | ZCode 产品服务 |
| Computer Use 占位包 | Lake 无 | 不作为可迁移现成功能 | 明确排除 | 不列入发布门槛 | ZCode `NOTICE.md` |
| Node/TypeScript Agent 与 Electron 壳 | Lake 使用 Go/Eino、Wails | 不引入第二套 Agent 运行时 | 明确排除 | 发布包无 Node Agent 进程 | ZCode 桌面/CLI 架构 |

每项由对应任务的测试与发布门槛确认后才改为“已覆盖”；不能仅凭文件存在改变状态。

2026-10-01 四项闭环补充：插件 MCP/Hook 运行、自定义专员、内部检查点恢复和工作流 v2 桌面管理已实现，详见[实施计划](../plan/feature-migration-closure-1.md)与[使用说明](migration-closure.md)。模型、MCP 和 Hook 验收使用本机模拟服务与临时工作区；真实 SSH/模型服务和用户 LaunchAgent 安装不属于自动化验收结论。发布门槛结果在实施计划记录。

同日按用户请求完成已登记 SSH 主机的手工联调：v1/v2 固定检查、内置/自定义专员、已完成检查点复用、进程中断后的专员恢复、v2 等待审批后的恢复与专员禁用通过。恢复未重复已完成的 SSH 操作。两项全盘文件扫描超时；本次未测试真实插件、非 SSH 资源或远端写操作。详见使用说明的真实资源联调记录。
