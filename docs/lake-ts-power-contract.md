# Lake Power 契约

Power 是能力集合，专员是独立 Agent 工单实例。所有能力经 ToolCatalog 投影、schema 校验、OperationGateway 和 ActionRunner；enable 只改变工具目录，不增加资源权限。

manifest 固定 id/version、说明、工具、inputSchemas、requiredResourceKinds、requiredGrants、effectPolicies、verificationProfiles 和 adapterFactory。首版只接受五个内置 factory ID，没有按路径动态加载或插件安装脚本。

工具 canonical 名称采用点号，如 `ssh.service_status`，模型协议使用确定的下划线别名 `ssh_service_status`，避免模型厂商的函数名限制。别名冲突在注册时拒绝。

effect 由受信 manifest/实现给出，取 read/change/interactive。资源先按 task/workOrder/lake/environment 解析，再校验 grant。审批绑定工具版本、资源身份/版本、参数、产物引用、任务契约、验收和重试次数的摘要；不能修改参数后复用审批。

read 只使用固定有限能力。SSH 写限定配置替换与 systemd 动作；本地 patch 绑定旧 hash 和 session 产物；K8s 禁止 Secret/exec/apply/delete，PG 禁止任意 SQL/DDL。外部进程使用固定 argv；模型没有通用 shell 或 PTY 按键工具。

ToolResult 明确 status、data、artifactRefs、truncated、retryPolicy、actionId 和公开错误。大输出保存受限私有产物，模型只获得片段与引用。秘密脱敏、路径边界、超时和取消属于能力实现的一部分。

加入能力时必须定义：输入范围、真实副作用、前置条件、效果证明、未知结果核对、回滚条件、授权范围和协议测试。执行退出码零只代表 observed；任务交付由 DeliveryGate 判据决定。
