# 本机生成文件卡片

2026-10-22，用户要求按参考图为本机生成文件显示卡片，并明确选择在 Lake 内预览。

本轮成功文件写入记录中，runtime=local 且不属于容器、未删除的文件显示独立卡片，包含文件名、类型、“本机”来源和打开按钮。卡片标题与按钮均复用原 FilePreview，预览会话已保存版本，展示完整来源路径。Markdown 排版并保留原文，其余文件按文本预览。同名文件补充路径；未确认、失败、删除和未知目标不会被推断成本机产物。原远程文件链接和所有差异记录继续保留。

检查：

- TypeScript 检查通过，file-links.test.ts 与 file-changes.test.ts 的 14 项测试通过，涵盖目标隔离、失败/删除排除、同名路径、Windows 文件名、格式标签、预览与原差异统计。
- 使用现有隔离 fixture 的 local 参数查看浅色、深色、360px 窄屏截图，长标题省略且没有水平溢出，按钮仍完整可见。
- 打开 Markdown 后包含排版、已记录完整路径和来源说明；脚本按原文显示，未执行。Escape 关闭并回到原打开按钮。预览未新增 API 请求。
- 正常对话运行中不提前显示卡片，结束后显示；后续更新保持 3 个文件、无重复，恢复历史不重播入场动画。
- 截图 lake-generated-file-cards-light.png、lake-generated-file-cards-dark.png、lake-generated-file-cards-narrow.png 已逐张视觉检查，均为虚构文件记录，无实际主机连接。

后续通过签名脚本更新 Lake Dev；不安装或重启正式版。
