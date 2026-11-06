# TS/ZCode 分层长期记忆

2026-11-06，用户确认采用 ZCode 原生 Memory，结合 Lake 的用户、项目和稳定专员分层。本文描述本批 TS 候选实现；旧 Go 产品不因本批变更启用、迁移或退役 Memory，完整后端等价门禁保持不通过。

## 归属与开关

- 用户层仅保存用户在设置中明确提交的跨项目偏好，供 Pilot 使用；不自动把项目消息提升成全局知识。
- 项目层保存直接提交给项目/Pilot 的长期偏好及明确共享资料；同项目 Pilot/Worker 按需使用。
- 角色层以 storeID/projectID/RoleID 为身份，保留真实角色消息及本角色任务的合格经验。名称、WorkerID、SessionID 和临时 child 名称不参与归属；改名保持，新建同名不继承。
- 新任务继续使用独立 Session。临时 child 仅继承父任务允许的知识片段，实际发现通过父 Task/Operation 回流，不生成 child 长期库。
- 项目及其角色共用积累/使用开关，内容仍分开。新 Home 默认关闭；开启只覆盖新来源，无历史扫描。用户层仅有使用开关及明确保存，不提供自动全局采集。

## 原生引擎和发布

`LakeMemory` 持久保存来源、设置、任务、水位、撤回和文件版本元数据；正文只有一套私有 Markdown 成品。复用公开 `AgentRuntime`、`memory.enabled/use/extractionEnabled`、`resolveProjectMemoryRoot`、会话存储和文件工具；不修改 ZCode 源码、不导入其私有 helper、不复制模型/工具循环。

一个合格来源入队后，在前台空闲时处理：

1. 根据准确 scope 创建私有暂存。复制该范围仍有效的成品，并生成原生 `MEMORY.md` 导航。
2. 独立原生 Runtime 只接收有界、脱敏且带来源状态的数据。简短 Main 确认后由原生 Background Extraction 写入暂存知识；不对业务 Worker 原始 transcript 直接开启无约束自动写库。
3. 使用公开 Model invocation context 确认 `project_memory_extract` 实际发生；记录调用尝试、供应商实际返回的输入/输出用量及未知用量。原生后台模型失败不能被记为发布成功。
4. 只允许当前暂存目录内有界 Markdown 的 Read/Write/Edit，无命令执行、MCP、网络工具或递归子委派。
5. 宿主重验设置、源模型端点、安全身份、角色、原消息/操作 hash、当前资源及权限版本，写完整私有文件版本后在 SQLite 事务中 CAS 更新可读元数据。每范围由同一发布者提交；并发人工修改使旧暂存失败。
6. 清理临时 Session 数据库及文件。进程崩溃后清理暂存和未提交文件版本，已派发记忆任务标 interrupted，不自动重派模型请求。

原生默认目录只提供一个 Runtime root，Lake 用准确 scope identity 映射它；用户/项目/角色多层读取由宿主适配。正式成品在当前 TS data 的 `memory/published/<scope-key>/<version>/`，私有状态继续在 `lake-typescript.sqlite`；旧 Go 正文不双读、不双写，不自动导入。

## 来源、读取与撤回

真实用户消息按当前来源频道归项目或角色；已验收目标需有实际业务工具回执。已确认且宿主证明只读的失败只能形成 failure lesson，保留失败标签；unknown、未决写入和自然语言伪成功不形成成功来源。每批最多取 8 条有界操作预览，保留准确 operation/hash/观察时间；动态数值不成为当前事实。

Provider 请求前重新投影当前合格知识，导航、正文和提示总计不超过 4096 UTF-8 bytes。Pilot 不默认读取角色私有知识，Worker 不自动继承用户全局偏好。正文不写回 SDK transcript。每次实际读取保留来源 ID；后续模型结果、流事件和工具派发再次校验，失效不放行。

更正/遗忘由设置中真实管理入口完成：先持久撤回并阻止旧读取/迟到发布，再清理相关正文、历史派生文件及捕获副本。保守来源依赖可能同时撤回多个编译笔记；原用户对话、业务操作/审批/验收档案保留。原生自动提取不删除既有来源，聊天不能冒称更正/遗忘已经完成。

Pilot 能从当前宿主信封重建工作集，去掉相关旧消息与任务摘要。普通会话/Worker 已使用撤回知识而不能安全重建时，停止受影响续接并提示新建任务；不清空原任务账本或重放工具。本轮忽略标志传递给 Router、Worker 和 child，涉及该输入的任务不作后续经验采集。

记忆目录异常时仅暂停 Memory；未使用记忆的新任务继续，已有知识依赖的续接保持关闭。文件、索引和记忆文字不签发资源权限，也不改变目标状态。

## 用户入口与当前边界

TS 后端通过 bootstrap `memoryEngine=zcode-layered` 选择新设置，普通 Go 保留原界面。新入口支持用户/项目/专员范围、开关、查看来源与版本、明确保存、更正、遗忘；使用 AppSelect、Glyph 和共享几何。新增 API 位于 `/api/memory`，每个 scope 先按当前项目解析；不把旧 Memory URL 的空桩当作迁移。

仍未完成：旧 Go Memory 数据显式迁移、Windows 原生验收、长期使用的真实供应商质量集、向量召回、云同步，以及整个后端的 118 项全量等价验收。本批只启用新的 TS 记忆链路，不复活退役 V2，不采用第二套 ADK 整理引擎。

详见[实施计划](../../plan/feature-zcode-layered-memory-1.md)和[验证记录](../validation/zcode-layered-memory/validation.md)。
