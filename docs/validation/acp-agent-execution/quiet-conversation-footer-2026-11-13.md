# 移除已完成对话的尾注

已测试、签名安装的源码：`a2d9e4004c390a919211fa50ec047111942036b3`。后续提交仅补充文档和截图。本记录取代[上次修订](conversation-feedback-2026-11-13.md)中“报数结束后仍显示人数和执行过程”的展示。

所有成员实际 replied 且轮次 completed 时，不渲染人数、完成提示或纯对话的“执行过程”入口。最后一名干员回复后直接结束。等待、失败、超时、取消与缺席继续显示原真实状态；有业务任务绑定或业务派单的轮次保留其详情。只改变前端展示，没有改写消息、对话、任务或操作记录。

## 验证

- 全量前端测试 816 项通过，0 失败/跳过；Web 类型检查和生产构建通过。
- `scripts/build_lake_desktop.sh --dev --install`、严格签名和干净来源验证通过。安装路径为 `~/Applications/Lake Dev.app`，Home 为 `~/.lake-dev`。
- 实际安装资产与后端中，原项目最后一轮仍有 6 个真实干员署名及完整回复；该轮 `.reply-duration` / `.pilot-conversation-progress` 元素合计 0，末条正文仍是“6号，发布专员报到！”。
- 浅色 1280px 宽窗、深色 390×844 窄窗已目视确认没有尾注；窄窗 scrollWidth=innerWidth=390。原生 Lake Dev 同样确认，并停留在原项目供用户试用。
- 复用上次的六人真实 Codex 回执验证本次展示，未追加模型请求。后台代码未改，本次未重复运行后台、Go 或其他平台测试。等待与缺席展示由既有前端回归覆盖。

完整应用与 Dev Home 已在停止后备份到 `~/Library/Application Support/LakeDevBackups/quiet-footer-20261113-120801/`（0700）。签名后端 SHA256：`1ffc1937ca7d19827b8e4f7b65ad4137e55a66d786d36e03a8d6d0c595f61b5a`。回退前必须先停止 Dev，再成对恢复备份。未合并受保护分支、发布或更新正式版。

- [浅色完成状态](quiet-conversation-footer/light.png)
- [深色窄窗](quiet-conversation-footer/dark-narrow.png)
- [界面指标](quiet-conversation-footer/metrics.json)
