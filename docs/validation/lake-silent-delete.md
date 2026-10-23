# 删除与移动遵循静默命令权限

2026-10-11。

用户要求开启 silentCommands 后，删除/移动不再逐次授权。现在 delete 文件工具以及直接 rm/mv、废纸篓命令、find -delete 在已明确的资源目标下遵循该开关；关闭时保留单次批准、拒绝无效应和批准不可重放。静默修改文件是另一项设置，不能单独授权删除。

资源选择、新建/重建终端仍由对应权限控制，禁止本机执行与本轮引用限制仍生效。分类保留 dangerous 风险标签与审计，增加 destructiveOnly 以区分单纯删除/移动和夹带其他危险效果的命令，不把删除静默扩展到任意脚本、凭据访问或服务控制。

模型工具说明、当前会话权限提示与权限面板文案同步更新。旧的待批准命令不自动接受，不重放已完成操作。

验证：
- TestDeleteToolFollowsCommandSilence：真实临时文件的 delete 工具，在开关开/关两种情况下分别直执行/批准执行。
- TestSilentCommandsExecuteMoveAndDeleteWithoutApproval：真实临时文件经 mv 和 rm，保存精确终端、资源与成功审计。
- TestTrashMoveRequiresApprovalWhenCommandSilenceOff：关闭时拒绝保留源文件，正确批准移动，仅一次有效。
- TestSilentDeletionStillResolvesTargetAndTerminal：静默不替代多资源选择或终端创建。
- TestDestructiveSilenceDoesNotCoverOtherDangerousEffects：混合解释器、凭据读取、替换和重启命令不继承删除静默。
- 聚焦 race 测试通过；前端构建及 9 个前端测试通过；签名脚本构建并严格签名验证。完整 internal/web + internal/ai race 测试通过，Go vet 与签名无 Node 运行测试通过。服务于当前授权轮次结束后更新，bootstrap 与最终静态资源验证通过。
- 独立测试 home 上确认权限面板的真实开关与说明。没有删除/移动用户文件、访问生产 SSH 或调用商用模型。

截图：lake-silent-delete-permissions.png。
