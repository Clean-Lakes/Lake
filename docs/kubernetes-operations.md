# Kubernetes 资源操作

会话使用资源保存的 API Server、Context 和凭据连接集群，不读取本机 kubeconfig、不执行 kubectl、不借用之前打开的 SSH 终端。资源名称是显示别名，无须匹配 kubeconfig 的集群名。

## 可用能力

- `query_kubernetes`：保留节点、Pod、事件、容量、命名空间及有界日志查询；增加 Deployment、ReplicaSet、StatefulSet、DaemonSet 查询。返回 UID、resource_version、所属控制器和副本/滚动状态，不返回完整 spec、环境变量或 Secret。
- `kubernetes_capabilities`：针对指定命名空间、对象和操作，通过 SelfSubjectAccessReview 查询当前账号权限，不改变工作负载。成功查询 Pod 不代表有写权限；无法完成预检表示权限未知，不应自动归因为凭据故障。
- `kubernetes_action`：支持 Deployment/ReplicaSet/StatefulSet 副本调整、Deployment/StatefulSet/DaemonSet 滚动重启、单个 Pod 删除。没有任意 API 路径、manifest、exec、集群资源删除或批量删除入口。

模型应先确认工具覆盖请求，查询具体对象及所属控制器，再完成对应操作的权限预检，之后才能承诺可执行。变更仍受当前用户意图、资源引用/目录范围、Lake 审批、Plan 模式和操作账本约束。只读调查子角色不获得这些变更能力。

每次变更要求查询得到的 UID 和 resource_version。副本数必须明确指定（支持 0），通过 scale 子资源的 update 请求；重启只合并修改 Pod template 的重启注解；删除携带 UID 和资源版本前置条件。提交变更前再次检查权限。资源版本冲突、超时及结果未知均不自动重试，先只读核对实际状态。

API 接受请求不等于 Pod Ready、滚动发布完成或业务恢复。应继续查询控制器、Pod 和事件验证结果。删除 Pod 可能被控制器重新创建；Deployment 也可能重置手动修改的 ReplicaSet 副本数，不能把此类操作承诺成必然释放资源或恢复服务。

## 长任务绑定

`work_begin.asset_refs` 声明实际目标（多个资源全部列出）。未提供时，只使用当前可信目录范围或本轮已有资源调用，不从历史回合、旧终端或旧资产选择推断新目标。若模型先建立目标再访问资源，首次通过资源/审批检查的实际调用补充绑定。

工作目标记录各资源的冻结身份，接续时逐一检查；不匹配则停止接续。非主机目标不会继承旧 SSH 终端。旧持久化目标仍保留原绑定，不通过升级静默迁移成另一资产。此前错误绑定的旧目标需结束后重新创建，避免把升级当作新的执行授权。

## API 依据

- [SelfSubjectAccessReview](https://kubernetes.io/docs/reference/kubernetes-api/definitions/self-subject-access-review-v1-authorization/)
- [ResourceAttributes](https://kubernetes.io/docs/reference/kubernetes-api/definitions/resource-attributes-v1-authorization/)
- [Kubernetes API resource versions](https://kubernetes.io/docs/reference/using-api/api-concepts/#resource-versions)
