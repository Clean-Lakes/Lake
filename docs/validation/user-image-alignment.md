# 用户图片右侧对齐修复

2026-10-29，PR #120 的界面增量。2200×500 纯图片消息可复现：缩略图只有约 260×59，外层 figure/按钮却占约 792px，图片绘制在左边，偏离用户消息右侧约 532px。此前 48×48 小图用例不能覆盖此问题。

将 figure 自身的最大宽度限定为 260px，结合既有 flex 收缩与 min-width:0 适配更窄会话列；不只限制 img。修复后该消息、figure 与点击区域均为 260px，右边误差小于 0.03px。不修改图片、消息、顺序或附件数据，不放大小图、不裁切。

扩展现有真实 App fixture 的 image-messages 场景，加入纯宽屏和纯竖屏截图。ego-browser 验证文字+多图、纯横图、纯竖图、48px 小图、明暗主题、420px 窗口和 220px 会话列（图片可收缩至 187px）：右侧对齐、保持比例、无横向溢出。点击与键盘 Enter 可打开原图，Escape 关闭并恢复原缩略图焦点。图片尚未进入视口可继续沿用 lazy loading。截图 `/tmp/lake-image-align-before.png`、`/tmp/lake-image-align-after.png`、`/tmp/lake-image-align-dark-420.png`、`/tmp/lake-image-align-light-final.png` 已查看。

前端 539/539、TypeScript 与 Web 构建通过；既有大 chunk 提示保留。只改样式与虚构 fixture，Go 后端无变化，未重复执行 Go 回归。Lake Dev 安装来源、签名及准确提交见 PR #120 和 build-origin.json；保留当前运行的 Dev 进程。回退仅恢复 figure 的样式约束，不修改会话数据。
