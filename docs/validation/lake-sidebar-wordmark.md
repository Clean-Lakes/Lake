# 轻量侧栏文字品牌栏

2026-10-22，按用户确认的渲染图实现：品牌使用纯文字 Lake，无水纹或其他图标。侧栏字标 20px/600、-0.9px 字距、正文主题色；品牌行 36px，左右 16px、下方 10px。Dev 使用约 30×18px 的淡灰小标、10px 次要文字和 5px 圆角。样式只作用于工作区侧栏，欢迎页品牌保持原有实现。

验证：

- TypeScript 检查、现有 appearance.test.ts 通过。
- 使用真实工作台隔离 fixture，包含原生客户端同样的后注入 DEV 样式，确认共享 CSS 覆盖正常：实际文本 Dev，无外框，字标没有 SVG。
- 浅色和深色截图 lake-sidebar-wordmark-light.png / dark.png 已逐张检查。正式版 fixture 中 Dev 伪元素 content=none。
- 390px 下为关闭按钮预留 58px，徽标与关闭按钮间距 12px；品牌图标数量为 0。Windows 标题栏样式检查仍为 48px 高。
- git diff --check 通过；通过签名构建后更新本地 Lake Dev，保持原项目/会话和数据目录。
