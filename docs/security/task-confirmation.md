# 普通会话中的任务与人工验收确认

使用现有问答卡片和原生审批，不增加 UI 或共享 DTO。提案、人工要求确认、资源权限和结果验收分别关联到同一目标，互不替代。

## 任务要求

受管理会话的 `work_begin` 先保存提案。新提案没有 SecurityTask、grant 或资源执行权限。后端将完整目标、原始请求、资源绑定、步骤和依赖冻结为私有 proposal，并通过原有官方 SDK input checkpoint 提问。

确认只建立逐步骤的 manual/human_verified 验收契约，再为这个首次提案建立 SecurityTask、根绑定与 owner。它保留原 root、真实源消息和目标最初的 DeadlineAt；已有任务不会通过此确认续期。后续实际 I/O 仍须通过当前策略、scope、预算和原生审批。拒绝、过期、步骤变化或原 root 已结束时不激活执行任务。

这类问题使用独立的 host 生成 QuestionID，不复用普通模型问题的 QuestionDecisions 缓存。同一会话/root 同时只保留一个未过期的 host 确认。答复记录绑定原问题摘要、源、版本和实际答案；模型生成的“已确认”文字不产生这条记录。完整提案无法在既有问题长度限制内展示时拒绝，不截断隐藏条件。

## 结果验收

执行成功与业务验收分别保存。自动适配器无法证明 manual 契约时，先保留不足的自动验收结果；只有原 canonical attempt 与全部操作已成功结算，才可再问一次独立人工核实问题。用户看到当前步骤的全部条件，并可选择全部满足或保留未完成。

人工 pass 在同一任务写事务中重新核对当前 goal/plan/step/progress 版本、attempt、条件摘要、原始操作快照，以及 answered 的真实 manual_work_verification 问题。条件、原结果或未决副作用变化都会拒绝；人工 yes 不解除 unknown、不覆盖失败或取消记录。

`workAcceptanceRecord.SourceKind=question`、`SourceInteractionID=QuestionID` 显式证明真实问题交互。`SourceMessageID` 仅保留原始来源关联，不能把原任务请求冒充验收声明；不伪造新的用户消息。验收记录和问题的 manual_verified 状态原子提交，同一动作可重入。目标汇总再次核对该独立来源，历史 pass 不成为永久成功位。

原有已鉴权管理验收 API 保持不变，记录 `SourceKind=user_action`；实际用户消息 ID 只保留为请求来源，不把原请求当成人工验收声明。普通问答、确认任务要求和模型总结均不能调用人工 pass 的可信分支。

## 权限与恢复

原目标受阻后，实际当前执行上下文可以为原步骤激活一次重试，不要求模型先把整个目标伪装成 running。依赖、契约版本、当前 task/root、Super-agent assignment 和未决操作检查仍在同一派发屏障内生效。原 prepared 尝试只有在规范操作账本计数为零、契约一致且原 task 仍属于当前 store/epoch 时，才可记录为 not_executed/reconciled，并追加宿主审计后创建带 retryOf 的新尝试；这不产生业务验收。存在任何原操作、unknown 或不明派发状态时必须走原核实路径，不能借步骤重试清除风险、跨恢复纪元继承旧执行资格或重放操作。

once/task 的问答只记录授权提案。最终原生审批必须展示并绑定实际资源、能力、profile、task revision、绝对到期时间、预算和 envelope 差异；签约仍在原审批领取事务中完成。签约后使用新 descriptor，旧单次批准不能扩成批量授权。

恢复保全原问题和验收历史，使未完成提案失效并切换 epoch；不从旧问答自动创建新权限，也不复用旧 owner。Memory 的同意与遗忘资格另行核验，任务或人工验收不表示 Memory 同意。
