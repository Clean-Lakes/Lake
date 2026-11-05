# Plan 入口仅保留在 Pilot

2026-11-05，代码 `12280f50`；签名安装并实际运行的干净 Dev 集成提交 `1ac91c1b77511838f3d8e65a63852f25ba15f628`。本记录仅补文档。

只有准确 workspaceRole=router 的主会话显示输入框 Plan 按钮；专员频道、独立 Worker、历史和普通会话不显示独立入口。输入 /plan 也通过同一模式切换入口：非 Pilot 会话提示在 Pilot 中切换，不提交模式修改。既有任务模式、计划正文、执行与审批保持原行为，本次只改前端入口。

源分支及 Dev 集成的类型检查、5项现有 Plan 回归、Web/签名桌面构建通过。改动为低影响 UI 条件显示，未新增镜像实现测试或重复后端测试。

Lake Dev 原生窗口确认 Pilot 有 Plan，数据库专员没有 Plan。安装后的 HTTP 前端确认 Pilot=1个入口、专员频道=0、独立 Worker=0；专员输入 /plan 得到 Pilot 入口提示，测试输入清空。520px深色 Worker 界面同样没有 Plan。没有触发真实模型查询或资源操作。

实际运行后端为安装后的 Resources/lake；HTTP bundle 与本地构建一致，SHA256 `cc4aaff0006d73b96b0dba26ae97b403aeaad343b96c7d6663ccee25bbcee1fa`。Dev保留其他开放PR，集成分支不推送。未重复Windows原生验证，没有数据迁移或权限变更；回退本次入口显示及前端切换守卫即可。
