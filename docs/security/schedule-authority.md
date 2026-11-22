# 历史调度记录

项目定时任务已移除。旧调度的 API、模型工具、后台领取和 Web 投递均停止。旧日程到期后不会创建提醒、启动模型或派发工作流，已经领取的旧实例也不会接续。手动工作流仍使用现行 Security 任务授权。

`tool-schedules.json` 保留原配置和执行历史。规范 ADK 库保留已有配置、grant、occurrence 和任务来源关联，供审计、备份恢复以及核对可能已派发的操作。原领取键由 `scheduleID + configRevision + originalDueAt` 派生，旧记录可继续关联原任务及工作流运行。恢复备份时禁用旧调度、撤销旧 grant 并切换 epoch。

核对历史操作时，`ValidateSecurityScheduleTaskSource` 仍检查原任务、occurrence、配置、grant、项目、会话和当前 epoch。缺失来源、记录不匹配、已撤销或到期时停止核对授权。新工作流准入、旧工作流激活、Worker 检查、模型及工具派发均拒绝已退役的调度来源。
