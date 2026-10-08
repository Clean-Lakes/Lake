# Lake 持久执行与恢复

状态和事件在同一 SQLite worker 事务提交。WAL、FULL synchronous、外键和实体 revision CAS 启用；网络与外部进程不跨数据库事务运行。

网关先冻结意图，校验授权/审批并取得资源锁，提交 queued。执行器再保存 attemptId 与 dispatched，提交后才执行外部 IO。返回结果记录 observed，验证通过才能 succeeded。

没有通用 exactly-once 保证。崩溃、超时、断线或取消后，已派发而未确认的写使用 unknown；不自动回到 queued。Reconciler 读取实际配置 hash/状态，确认已发生、未观察到当前效果或仍不明确。无法证明的结果保留写控制，等待只读核对或明确人工处置。

固定只读动作按策略重试；写动作不盲目重放。派发前取消可最终 cancelled；派发后先 cancelRequested，不能把本地 AbortSignal 当远端进程已停止。

终端保存逻辑 ID、输出 cursor、owner 和输入 epoch；真实连接 handle 不落盘。重启后连接重新建立，先检查未结算行动，再重建 managed 视图。旧 PTY 不宣称恢复，旧输入 epoch 不能再次输入。人工接管的写隔离不能仅因租约到期解除。

模型历史保存完整 assistant/tool 配对。半截流不执行工具，也不进入成功历史。检查点保留摘要、已保留历史位置及需要恢复的技能 digest；用户指令在 durable inbox 中续读，失败请求不会删除约束。

备份使用 SQLite backup 接口。不能只复制正在 WAL 写入的 agent.db 文件。私有产物使用原子文件写入、SHA256 和数据库引用，读取核对权限与摘要。

实际故障验收包含外部写前、写成功回执落盘前和 observed 后验证前的 SIGKILL；测试确认同一 attempt 没有再次派发，并分别验证现场和最终状态。详见验证记录。
