# ZCode 通用 Agent 接入验证

2026-11-06。范围为固定 ZCode 3.17.2 的通用 Agent 内核及 Lake Task 资源适配。沿开放 PR 188 增量交付；普通默认构建/生产后端和完整 TS 产品切换门禁不变。

## 行为与归属

- Pilot、专员 Worker、原生临时 child 共享通用执行工具。Pilot 可以直接执行，首次实际业务/控制工具才建立原 Task；纯对话和路由不创建假执行。直接任务沿原轮次/目标、独立 Todo、准确 Operation 和有界工作集隔离；独立 Worker/child 使用独立 SDK Session。
- 原生 Bash 连接实际本机/SSH ExecutionPort；SSH 从准确资源与当前 configuration_revision 解析宿主私有凭据，首次/变化指纹仍须确认。模型能自主使用远端已安装的 kubectl/mysql 等 CLI，专用固定指标/数据库工具仍可复用。
- 本机 macOS Seatbelt 限制 Lake 私有 Home、正式 Home、SSH 密钥及 Keychain；不支持的平台拒绝本机 Shell。命令超时、输出预算、后台 TaskOutput/TaskStop 和父任务停止连接真实进程/通道。关闭 SSH 不证明远端副作用回滚，不透明中断保留 unknown。
- 前台/后台实际结果进入原 Operation。后台仍运行时不能验收；完成后原记录结算，不建立第二套完成权威。资源、配置/凭据、项目策略、父任务 generation 和权限在调用及回执使用时重验。
- SDK Plan 切换、AskUserQuestion 和 Skill 连接实际 Lake 交互/目录；退出计划须真实审批，不扩大后续权限。SDK 重新注册工具时，宿主包装仍保留。Todo、发现与协作控制不是业务成功证据。
- 固定上游在 Bash 分支隐藏 Glob/Grep；Lake 通过公开 handler 以 FindFiles/SearchText 接入相同能力。工具发现使用公开 auto/local 模式。图片通过 Jimp 原生 adapter 处理；保留全部实际打包依赖许可与原包遗漏的固定版本许可证。
- 点击历史 Pilot 轮次按该轮真实任务身份加载第三联，轮询保留准确 taskId；不能借用最新任务的子实例/工具回执。直接 Pilot 经验归现有项目 Memory，专员经验归稳定 RoleID，child 经父任务回流。

## 自动检查

在代码提交前通过：

| 检查 | 结果 |
| --- | --- |
| TS 类型、固定源码 bundle | 通过 |
| server + MySQL + router-context | 107/107 + 不透明命令非零退出专项 1/1 |
| Task/assets/activity/Memory/lifecycle | 57/57 |
| React 类型、前端测试与构建 | 653/653，Vite 构建通过；保留现有大 chunk 提示 |
| ADK runtime boundary | 通过 |
| Dev Home / 进程占用 / 构建来源保护 | 16/16 |
| 完整 TS parity | 按预期拒绝，118 项、20 个领域尚未全量验收 |

新增实际 SDK 测试包括：Pilot 直接 Bash 与原 Task、子智能体实际 Bash、后台汇合、秘密隔离、SSH 通用命令/后台实际退出、指纹确认前无认证、配置变化后旧批准不执行、危险命令即使启用普通命令免确认仍询问、Plan 重新注册后保护仍有效、问题回答续接、真实文件搜索/读写/编辑、任务 Todo 隔离、Skill 读取、图片模型投影、直接任务续接保留期限与累计轮数、停止真实命令与不透明命令非零退出保留未知结果、准确历史检查与跨项目拒绝、能力目录不虚报未接服务。Memory 补测 Pilot 已验收经验进入项目及原操作变更后的读取失效。

## 隔离界面复核

使用本机模型协议夹具、真实 SDK 和临时 Home 的 React 页面；没有派发用户历史比较或操作真实数据库。Ego Browser 同一 TaskSpace 验证两项独立 Pilot 任务之间切换、第一项原生 child 创建/结束与实际 Bash 输出、浅色/深色、820px 窄窗、Escape 关闭。焦点恢复未在动画结束后单独复核。合成截图只包含测试数据。

## 签名 Lake Dev

安装来源与启动验证在签名构建后追加；当前记录不把尚未完成的安装写成通过。Dev 使用固定 ~/.lake-dev，保留原资源、专员、消息与未决记录。正式 Lake 未安装、未重启。

## 明确边界

`GET /api/agent-capabilities` 遍历完整公开 builtInTools，给出 connected/model_dependent/requires_host_service 和实际别名。原生 WebSearch 只在固定上游编码器支持的 Anthropic 协议且模型显式启用时开放；真实供应商搜索未验收。动态工作流、Cron/OffPeak、浏览器桥接、跨 Session 档案读取还需对应宿主服务及范围适配，不注册成功占位。完整 TS 平台、附件、调度和既有安全产品等价验收未包含于本批。

本机 Shell 仅验证 macOS；Windows/Linux 隔离执行器尚未接通。PDF adapter 已连接，但依赖模型显式 PDF 能力及已安装 Poppler；PDF/视频/音频和真实供应商长期质量未作端到端验收。测试使用本机 SSH 协议夹具；没有对用户实际 K2、MySQL 或生产业务执行探测或改动。

## 回退

保留安装前 Dev 应用与同 Home 私有备份。退回旧 Dev 构建不重放 commandExecutions/superOperations；保留未知效果并核实。PR 未合并前保持分支可审阅；合并及生产发布分别遵守仓库授权要求。
