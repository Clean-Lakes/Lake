# 设置分类尺寸与结论交接验收

修复两个连续反馈：设置弹窗从“接入渠道”切换到其他分类时变小；专员出结论前先出现“执行结束”提示，再刷新结论。

## 实现与检查

- 产品提交：`6107d83d`。最终签名安装与 Dev 验证提交：`4caf29949da439ae1ff9091a62d12d4c8e2aef06`，0.3.33 / TypeScript，`dirty=false`。后一提交仅为设置 fixture 增加类型约束并修正合成路由数据，产品源码相同。
- 全量前端回归 **942/942**；前端 TypeScript 检查、Web 构建、`git diff --check` 通过。
- `npm_config_offline=true scripts/build_lake_desktop.sh --dev --install`：通过，签名构建并安装到 `~/Applications/Lake Dev.app`。
- 无后端、权限或数据迁移修改；本轮未重复运行未改动的 ACP 后端协议测试。

## 设置分类尺寸

原来的 `channels-dialog` 在接入渠道页单独使用 1248px/940px 上限，并放大标题和页签；其他设置使用共享 980px/760px 上限。因此分类切换本身会改变外框尺寸与位置。

现在所有分类统一使用共享弹窗和标题/页签样式；接入连接列表适配公共内容宽度，长内容在内部滚动。模型、输入框、AppSelect、按钮等控件尺寸及连续圆角沿用共享规则。

真实 `ModelSettings` 浏览器 fixture 开启全部九个分类并使用合成连接、模型、记忆等数据；未知请求及所有写请求被拦截。四种视口各验证十二次分类选择，共 **48 次**。每个视口内所有分类的 x/y/宽/高完全相同；关闭按钮始终在框内，弹窗横向溢出为 0。

| 视口 | 外框 x/y | 外框宽/高 | 主题 |
| --- | --- | --- | --- |
| 1440 × 1000 | 230 / 120 | 980 / 760 | 浅色 |
| 1100 × 700 | 60 / 32 | 980 / 636 | 深色 |
| 760 × 620 | 24 / 32 | 712 / 556 | 浅色 |
| 390 × 844 | 18 / 16 | 354 / 812 | 深色 |

浅色桌面与深色窄窗口已检查实际圆角、选中页签、内容裁切和滚动区域。处理方式 AppSelect 可展开，Escape 后关闭列表并将焦点留在触发按钮；没有修改连接设置。

签名 Lake Dev 中创建仅用于隔离验收的连接，逐项选择接入渠道、Agent 执行器、模型、MCP、Skills、记忆、对话、巡检和外观。全部九项实际选中，原生截图的中央横纵截线表面边界均为 `[99,66,2054,1421]` 像素。实际外框、圆角和标题区保持一致。

证据：[浏览器尺寸数据](settings-dialog-handoff/browser-settings-geometry.json)、[下拉焦点](settings-dialog-handoff/browser-settings-focus.json)、[桌面浅色](settings-dialog-handoff/browser-settings-light.png)、[窄窗口深色](settings-dialog-handoff/browser-settings-dark-narrow.png)、[原生九页测量](settings-dialog-handoff/native-settings-geometry.json)、[原生模型页](settings-dialog-handoff/native-model-settings.png)、[原生接入渠道](settings-dialog-handoff/native-channel-settings.png)、[原生外观页](settings-dialog-handoff/native-appearance-settings.png)。

## 进度直接接替结论

任务完成与正式报告来自独立更新流。此前完成空档会额外显示“执行结束”，晚到的收尾播报或缺少 SDK root 的快照还可能改变正文，随后报告又触发布局变化。

现在按完整显示绑定与已观测的真实 SDK root 保留最后一次已提交到界面的公开段落。工作区或准确 Worker 快照先报告成功结束时，正文保持不变，工作动画停止；不额外插入结束提示，也不让晚到收尾段或空快照顶替。宿主正式报告到达后沿用原容器的 160ms 局部过渡。失败、取消、断线和真正的新执行沿用原状态，不跨任务保留正文；完整原始记录仍在执行过程内。

新增回归覆盖成功空档、收尾正文、缺失快照、Worker 先于工作区完成、不同 SDK root、绑定变化和失败/取消。调整此前刻意要求展示成功结束提示的断言。

浏览器通过真实 `AITranscript`、SSE/快照投影和 `FollowScroll`，分别运行 Native 与 ACP：

1. 显示 257 字长进度，并加入后来一条用户消息；停止末尾跟随后捕获原节点。
2. 依次送达源快照先结束、工作区完成、收尾播报、缺少 SDK root/卡片的空快照。正文与 264px 高度不变，无结束小字；署名、正文、历史和并行专员节点保持原对象，阅读位置不变。
3. 正式报告到达时各采样 36 帧：空白正文帧 **0**，结论最多 **1** 份，正文高度从 264px 经过中间值平滑回到 26.25px，原容器不替换，`scrollDelta=0`。
4. 减少动态效果时直接展示报告，正文容器动画数为 0，原节点与阅读位置保留。

最终签名 Dev 在临时 Home、独立 Web data 和确定性回环模型中真实运行两位专员；猫头鹰完成首段、本地 `work_wait`、第二段及 `work_finish` 后，主会话直接显示一份准确正式报告并保留“执行过程”。没有连接业务资源或真实模型服务。原生截图验证前后呈现；160ms 窗口的精确采样以浏览器证据为准。

证据：[Native/ACP 完整逐帧数据](settings-dialog-handoff/browser-report-handoff.json)、[最终签名构建与报告元数据](settings-dialog-handoff/native-build-and-report.json)、[原生第二段进度](settings-dialog-handoff/native-progress.png)、[原生最终结论](settings-dialog-handoff/native-conclusion.png)。

独立浏览器空间与 Vite 已关闭。隔离任务完成后停止临时原生内核，恢复日常 Dev 原项目/会话与模型。日常 Dev 数据和凭据未复制到测试环境，正式版 Lake 未操作。普通 develop PR 无自动 CI；以上为本地与 macOS Dev 验证。Windows/Linux 原生未运行，尚未合并或发布生产。
