# 侧栏留白与转角修正 · 2026-11-13

按用户对实际 Dev 截图的反馈收紧侧栏。新增、导入和批量入口共用资源页签右侧的动作位，不再独占资源标题行；资源列表直接衔接页签。Pilot 使用 48px 行高和 14px 转角，页签使用 28px 高度和 8px 转角，沿用共享 `--corner-window` 曲线。新增目录取消后，在浏览器完成模态焦点切换的下一帧恢复“＋”入口焦点。

验证代码提交：`718da90303be0a41c661a312f5ae2a2de714695d`。已按 `scripts/build_lake_desktop.sh --dev --install` 签名安装 Lake Dev 0.3.32，使用 `com.cleanlakes.lake.desktop.dev` 与原 `~/.lake-dev`；安装来源、二进制 hash 和指标见 [evidence.json](compact-sidebar/evidence.json)。最终安装来源为 `6c0054aba76e9474b74cf0de4f0bb39c2b5c98dc`，构建时工作区干净；与验证代码的差异仅为 docs，构建输入相同。

| 实测项 | 调整前 | 调整后 |
| --- | --- | --- |
| Pilot 高度 / 转角 | 56px / 22px | 48px / 14px |
| 桌面页签高度 / 转角 | 32px / 10px | 28px / 8px |
| 页签容器底部至首条资源的间距 | 63px | 7px |
| 独立资源动作行 | 1 | 0 |
| 新增入口 | 列表上方单独一行 | 与页签同一行 |

`pnpm --dir web-agent test:frontend` 816 项通过，`pnpm --dir web-agent build:web` 的类型检查和构建通过。Node 使用仓库固定的 24.14.0。深度严格代码签名和 Dev 来源检查通过。

隔离夹具验证了页签切换不移动按钮、新增菜单键盘选择、导入回调、取消新建目录与焦点返回。安装后的实际 Dev 再次验证了指针取消后的焦点返回、新增/导入/目录三个菜单项、弹层边界，以及原生窗口中真实的留白和圆角。1110×770 明暗主题和 390×844 窄窗口均已查看；模拟触摸时页签和新增按钮为 44px，未出现横向溢出或菜单裁切。主题恢复浅色，原生 Lake Dev 保持打开。

截图：[浅色](compact-sidebar/light.png)、[浅色菜单](compact-sidebar/light-menu.png)、[深色菜单](compact-sidebar/dark-menu.png)、[窄窗口](compact-sidebar/dark-narrow.png)。此次只调整前端呈现和焦点，不重跑后端业务、Go/race/vet 或其他平台的检查；未提交新建目录、执行远端命令或发送模型请求。此前 ACP 和多人对话验证记录继续保留。

回退备份位于 `~/Library/Application Support/LakeDevBackups/compact-sidebar-20261113-135142/`，权限 0700。回退前停止 Dev，再成对恢复其中的应用与 Home。正式版未变更，PR #224 继续指向 develop，未合并。
