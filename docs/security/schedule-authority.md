# 调度授权与发生实例

本实现保留现有调度 UI 和返回字段。调度 JSON 保存配置与已有展示历史；规范 ADK 库保存授权、唯一发生实例及其真实任务关联。Web run 是规范实例的幂等投影，不产生第二份执行授权。

## 配置、授权与状态

- `configRevision`、`authorityRevision` 绑定项目、会话、原始计划锚点、周期、工作流版本与摘要、消息和保存的选项。内容变更先登记 `changing`，撤销旧 grant 并暂停派生任务，再原子替换 JSON，最后提交 `ready`。中断保持不可领取新实例。
- 工作进度、结果和 Web run 关联只修改 `statusRevision`，不改变配置版本或重新生成授权。
- 现有开关是可用性开关：关闭后不再领取新实例，已经领取的任务继续受原绝对到期时间和预算限制。它不续期、不重置次数。修改配置或明确撤销 grant 会使派生任务失去后续派发权限。
- 恢复备份始终禁用调度、撤销旧 grant，并切换 epoch。旧实例不能自动接续或追补。

## 明确授权

`GET/POST/DELETE /api/projects/:project/schedules/:id/grant` 复用现有 Web 鉴权。actor 由后端固定为实际用户动作，不接受请求中的 actor 或模型的 `approved=true` 作为授权来源。

工作流授权必须明确给出 `expiresAt`、`maxRuns`、`taskTtlSeconds` 和严格类型的 `taskGrant`，并带 actionID、配置及授权版本；撤销还需要 grantID 与其 revision。一次有效的 actionID 可重入，冲突的请求内容拒绝。每个配置最多存在一个尚有剩余次数的有效 grant。

当前范围限于只读能力和固定只读命令 profile：`disk_usage`、`process_snapshot`、`service_status`、`service_logs`。不接受任意 Shell、写操作、服务重启或 opaque MCP 的未来批量授权。每次 grant 同时检查当前项目硬上限、资产 ID、连接版本/摘要/身份和已确认的工作流验收契约版本。现有本地提醒只投递本地系统消息，不产生 Agent/模型/资源授权。

## 实例领取与崩溃

领取键为 `scheduleID + configRevision + originalDueAt`。工作流只接纳当前时间附近的原计划时刻，跳过错过的实例，不将重新启用时间当作旧实例的新身份。

在同一 ADK 事务中登记 occurrence、扣一次调度次数、创建带版本目标的 SecurityTask/根执行绑定、签发单次运行 task grant，并保存 task-source。子角色只使用已冻结的 ChildScopeIDs，共享同一 task grant 的预算。事务回滚不扣次数；已登记但结果不明的实例不自动退款或重派。

事务提交后通过确定性 runID/sessionID 幂等补建 Web run，再显式激活一次。重启只补本地历史投影，将未准入运行标为 interrupted，不启动模型或重新授予权限；投影失败保留未完成的规范记录并向启动调用方返回错误。提醒使用确定性 messageID，重复领取和投递不会生成第二条提醒。

最终派发必须调用 `ValidateSecurityScheduleTaskSource`，同时核对 task、原 occurrence、配置、grant、项目、会话和当前 epoch；调度来源缺失不能退回普通交互授权。该检查也用于孤儿执行核实。调度次数用尽不撤销已经领取的实例，明确撤销、真实配置变化、到期或 epoch 改变则使其失效。

## 验证范围

测试覆盖并发重复领取、一次扣费、原计划时刻校验、事务回滚、验收契约修改、暂停不续期/不重置、明确撤销 CAS、断裂来源关系拒绝，以及已鉴权 grant API 的正反向行为。上述测试不是实际资源适配器覆盖证明；全部入口的最终 I/O、撤销、恢复矩阵完成前，不得据此将 enforced 覆盖清单标为完成。
