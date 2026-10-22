# P3 可见策略资产与请求注入

本文记录 P3 交付时边界；P4 已启用的学习接口、界面和 v2 迁移见 [P4 说明](strategy-learning-candidates-v2.md)。

P3 达到 M1：用户可手写、查看、导入、导出、明确采用、停用和回滚资产。初始四个开关仍关闭。自动学习、候选提取、实验比较、有界纠错与效果评估分别属于 P4～P7；保存相关偏好不启动 worker。入口是「工作区 → 设置 → 策略资产」。

## 范围、版本和界面

默认选择当前项目；无项目时选择用户全局。切换到全局是明确操作。用户全局设置是上限，已保存项目设置逐项相交，未保存项目设置继承全局。界面区分继承、保存值和实际应用值。总开关不会同时打开三个子项；自动学习/纠错在本阶段显示为不可操作的后续能力。

正文保存产生新候选修订，精确采用绑定单独提交。查看旧版本后编辑，以该版本为 parent、最新资产 revision 为 CAS，创建分叉；不会改变原已采用版本。停用会覆盖同一逻辑资产的全局绑定；回滚只能指向更早版本。不同资产的同名标题不是同一身份。

界面提供父版本正文差异、验证等级、hash、分页版本和血缘记录。user_confirmed 表示用户确认过正文，不证明效果。私密来源的可见性仍由 P2 仓库检查；新增 sourceKind 和 hasMore 仅用于准确展示、结束分页，不改变来源权限。

## 同源接口

在现有 Host/Origin、Bearer/HttpOnly cookie 认证之后注册，沿用单机当前本地用户身份：

- `/api/strategy`：用户全局。
- `/api/projects/:projectId/strategy`：服务端验证活动项目。路径选择范围，不接受请求正文中的项目/actor/权限。
- `GET/PATCH settings`；`GET/POST assets`；`DELETE assets/:id`。
- `GET/POST assets/:id/revisions`；`GET assets/:id/revisions/:revision`。
- `GET/POST assets/:id/bindings`；`GET assets/:id/lineage`。
- `POST imports/skill`：只接收已登记的 Skill 名称和内容分类/适用条件，不接收文件路径、hash、来源 ID、验证等级或可信 actor。

请求使用 camelCase 独立 DTO；变更需 Idempotency-Key，创建需 expectedRevision=0，编辑/绑定/删除/设置需相应 CAS。设置必须显式提供四个布尔值和完整九项 budget。拒绝未知字段（含大小写别名和嵌套字段）、重复 JSON key、null、尾随文档、错误类型和超过 128000 字节的请求；单正文另受 100000 字节限制。列表每页最多 50 项。错误只返回可展示的通用说明及 strategy_ code，不回显原文。

项目路径可查看全局资产并为本项目建立覆盖绑定；修改/删除全局正文必须切换到全局路径。全局路径不能读取项目资产。尚未交付的 proposals/experiments 等接口返回不支持，不能返回空成功。

HTTP 写入与读取正文检查已配置模型密钥（包含未激活供应商）、已知终端认证秘密及 P2 敏感内容模式。只读取已配置供应商引用的凭据，不扫描目录，不访问 Keychain。运行时再按当前 Config 脱敏规则和实时已配置凭据拒绝敏感正文；历史正文后来与新配置凭据重合也停止注入。缺失宿主会话或凭据适配器异常返回安全停止错误，不向 SDK 回调抛出宿主 panic。模式检测不构成对任意未知秘密的识别保证。

## 导入与导出

手写或便携 JSON 文件导入均由用户检查正文后保存，登记新的 manual_authoring 确认事件。便携格式 `lake-strategy-v1` 仅包含 title/kind/body/applicability；外来 identity、scope、来源、采用状态、验证声明和开关不恢复为可信状态。

Skill 导入通过既有 extensions.Store 安全路径/扫描规则读取已登记且启用的用户所选 Skill。创建独立资产、真实 skill_import 事件及精确原文 SHA-256，不覆盖源文件。此入口仅覆盖设置中已登记的 Skill，不把项目名称映射为磁盘工作区。源文件变化、同名解析变化、停用或不可读，快照正文不变，界面显示来源已变化，运行时停止使用；重新导入后由用户明确采用。

导入确认不替代会话读取权限：DenyLocalExecution 或 SilentReadFiles=false 时，Skill 来源资产省略为 skill_read_permission_required，不借自动注入跳过 load_skill 的确认流程。需要按需权限确认时继续使用原 load_skill；原工具行为保持。

导出由浏览器下载资产 JSON 或新的 SKILL.md；不提供服务端任意路径写入接口。保存位置和已有文件处理遵循用户代理/系统保存流程，默认下载新文件；导出后不会自动登记或启用 Skill。用户明确编辑资产产生的手写修订具有新的手工确认来源；原 Skill 血缘仍能经 parent 追溯。

## 解析和实际请求

`internal/strategy/selection.go` 是无 I/O 的确定性解析器。可信 Web 适配器从实际宿主 session 查项目，不使用模型参数或 MemoryProjectID 作为项目授权。普通 Web/Desktop core、terminal2、db-query-editor 接到原 ADK 唯一模型循环；不新增模型工具。

解析顺序与保守边界：

1. 全局/项目开关均允许应用；普通会话只读明确采用绑定。
2. 同一资产项目绑定覆盖全局绑定，显式停用也覆盖。不提供本轮资产覆盖入口，因此本阶段不存在从模型传入的临时绑定。
3. 核对精确 revision/hash、来源可用性、当前 profile、真实已选资源类型。领域标签只接受宿主明确标签，P3 会话尚无标签入口，因此带标签资产被省略，不从自然语言猜测。
4. 同一适用互斥组有多个资产时全部排除。priority 仅确定排序（高值先，同值 assetId 升序）和预算裁剪；相同正文 hash 去重。
5. 上限 200 个可见绑定；超过时停止并要求减少，不静默读取无界集合。资产 envelope 预算最多 8 KiB，再取实际请求剩余预算较小值，考虑 JSON 二次转义和元数据开销。
6. 实际请求前与已有记忆/成功 Skill 工具正文精确去重；正文仅在请求副本中添加为低权限 JSON 资料，当前用户要求及固定权限优先。原持久化首条 system 保持内置内容，不将资产原文保存为新的 system 历史。

请求级 PromptManifest 记录实际 selectedAssets/omittedAssets、理由、全局/项目设置 revision 和 generation、实际 fragments/system/request hash；不保存正文或凭据。零值新增字段省略，P1 关闭状态黄金样例保持。首轮冻结 body-free Selection 并经既有 ADK projection 持久化；后续只允许该精确集合，不用新 revision 偷换运行中的版本。

模型请求前（含输出恢复）、上下文整理前、每个模型工具前重新核对 generation、选择集合和 Skill 来源。采用/停用/设置/删除提交后取消受影响项目的旧策略轮次，全局变化取消所有相关轮次；正文新建、未采用修订不取消现有任务。改变目标或权限导致集合变化时也停止，用户可发新消息按新配置开始。不会自动重放或撤销已派发外部效果，原操作账本/unknown 对账继续权威。

SRE 协调器、隔离专员、工作流收尾以及未连接可信适配器的 CLI/stdio 不注入资产；不借 core profile 的继承错误地扩展适用范围。本阶段没有效果对比 UI 或性能提升承诺，A/B/C 和固定判据在 P5 实现。

## 数据兼容与回退

不修改 P2 冻结 DDL，不新增迁移版本。新字段是可重建 API/清单/投影元数据。可先关闭总开关，再经 PR 回退到 P2 代码；已有资产及血缘保留，但旧代码不会应用。回退到 P2 以前版本仍须使用 P2 文档的隔离兼容副本流程，不能恢复数据库覆盖后续业务/ADK 操作账本。

验证见 [P3 验证记录](../validation/lake-strategy-learning-p3.md)，整体阶段见[开发计划](../../plan/feature-strategy-learning-1.md)。
