# 普通会话中的任务与人工验收确认

使用现有问答卡片和原生审批，不增加 UI 或共享 DTO。提案、人工要求确认、资源权限和结果验收分别关联到同一目标，互不替代。

## 任务要求

受管理会话的 `work_begin` 先保存提案。新提案没有 SecurityTask、grant 或资源执行权限。后端将完整目标、原始请求、资源绑定、步骤和依赖冻结为私有 proposal，并通过原有官方 SDK input checkpoint 提问。

确认只建立逐步骤的 manual/human_verified 验收契约，再为这个首次提案建立 SecurityTask、根绑定与 owner。它保留原 root、真实源消息和目标最初的 DeadlineAt；已有任务不会通过此确认续期。后续实际 I/O 仍须通过当前策略、scope、预算和原生审批。拒绝、过期、步骤变化或原 root 已结束时不激活执行任务。

这类问题使用独立的 host 生成 QuestionID，不复用普通模型问题的 QuestionDecisions 缓存。同一会话/root 同时只保留一个未过期的 host 确认。答复记录绑定原问题摘要、源、版本和实际答案；模型生成的“已确认”文字不产生这条记录。完整提案无法在既有问题长度限制内展示时拒绝，不截断隐藏条件。

## 关闭失效问题

确认卡片的有效性绑定原 store/epoch、项目、任务、来源、root 和期限。后端读取闲置会话时，将过期、已换轮次、任务已终结或已结束交互的残留问题移出当前等待状态；pending 问题登记为 expired，原问题及已有答案历史保留。有效的 SDK 待输入仍能跨正常重启恢复。

跳过失效卡片只关闭等待，不记录答案、不恢复旧 SDK checkpoint、不建立契约、授权或人工验收；重复关闭可以安全重入。过期的肯定答复仍被拒绝并清除失效卡片。停止会取消当前执行并关闭残留问题，完成任务的结果与验收保持原样；未完成任务仍按原取消流程处理，未决操作不因此消失。旧问题取消回调不能清除新轮次的问题。

## 结果验收

执行成功与业务验收分别保存。自动适配器无法证明 manual 契约时，先保留不足的自动验收结果；只有原 canonical attempt 与全部操作已成功结算，才可再问一次独立人工核实问题。用户看到当前步骤的全部条件，并可选择全部满足或保留未完成。

人工 pass 在同一任务写事务中重新核对当前 goal/plan/step/progress 版本、attempt、条件摘要、原始操作快照，以及 answered 的真实 manual_work_verification 问题。条件、原结果或未决副作用变化都会拒绝；人工 yes 不解除 unknown、不覆盖失败或取消记录。

`workAcceptanceRecord.SourceKind=question`、`SourceInteractionID=QuestionID` 显式证明真实问题交互。`SourceMessageID` 仅保留原始来源关联，不能把原任务请求冒充验收声明；不伪造新的用户消息。验收记录和问题的 manual_verified 状态原子提交，同一动作可重入。目标汇总再次核对该独立来源，历史 pass 不成为永久成功位。

原有已鉴权管理验收 API 保持不变，记录 `SourceKind=user_action`；实际用户消息 ID 只保留为请求来源，不把原请求当成人工验收声明。普通问答、确认任务要求和模型总结均不能调用人工 pass 的可信分支。

## 权限与恢复

原目标受阻后，实际当前执行上下文可以为原步骤激活一次重试，不要求模型先把整个目标伪装成 running。依赖、契约版本、当前 task/root、Super-agent assignment 和未决操作检查仍在同一派发屏障内生效。原 prepared 尝试只有在规范操作账本计数为零、契约一致且原 task 仍属于当前 store/epoch 时，才可记录为 not_executed/reconciled，并追加宿主审计后创建带 retryOf 的新尝试；这不产生业务验收。存在原操作时不能走空尝试路径；unknown 或不明派发状态仍须按原核实协议处理，不能借步骤重试清除风险、跨恢复纪元继承旧执行资格或重放操作。

同一目标后续真实轮次可以继续取得新的只读观测：原尝试的所有操作必须已成功结束、具有可校验的非 opaque 只读 descriptor，且原资源连接、契约和 store/epoch 仍匹配。宿主只把该尝试的执行事实记为 succeeded/reconciled 并追加审计，为当前有效 task/root 建立带 retryOf 的新尝试；不复用旧 permit、不重放原操作、不生成业务 pass。原成功写入、未知结果、未结束操作及描述不完整的历史均不能借此刷新；权限、调用额度和绝对期限继续按当前状态检查。

效果判定使用经过校验的冻结 descriptor。通用 Shell 的旧 risk 字段可能仍是 write，但已登记、冻结并成功返回的 disk_usage/process_snapshot 等只读诊断不因此冒充未核实写入；原 risk、status、result 和 descriptor 均保持原样。opaque Shell 或真正包含写入能力的操作不能借此继续。

once/task 的问答只记录授权提案。最终原生审批必须展示并绑定实际资源、能力、profile、task revision、绝对到期时间、预算和 envelope 差异；签约仍在原审批领取事务中完成。签约后使用新 descriptor，旧单次批准不能扩成批量授权。

恢复保全原问题和验收历史，使未完成提案失效并切换 epoch；不从旧问答自动创建新权限，也不复用旧 owner。Memory 的同意与遗忘资格另行核验，任务或人工验收不表示 Memory 同意。
