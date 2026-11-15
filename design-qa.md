# 接入渠道设计验证

- Source visual truth: `docs/validation/typescript-candidate/incoming-channels/design-reference.png`，1538 × 1022。
- First implementation: `docs/validation/typescript-candidate/incoming-channels/dark-desktop-initial.png`，已安装签名 Dev `8a93b9f9`。
- 比较 viewport：1538 × 1022 CSS px，deviceScaleFactor 1；两图均 1538 × 1022，无密度缩放。在同一图片输入中并排检查。
- 状态：深色、3 条连接、选中「我的 Codex」、最近消息关联两项任务，1 份报告已提交、另一项运行中。隔离项目名称和消息前缀不同；浏览器没有 macOS 标题栏，背景资源为测试数据，均不作像素偏差。

## Findings / comparison history

首次比较：blocked。

- [P2] 渠道弹窗仍沿用 760px 高度；参考约 939px。在相同 viewport，汇总与测试接入落到可见区域之外。修复：只调整渠道弹窗高度，保留较小窗口内滚动。
- [P2] 两个路由字段没有对齐。实际「处理方式」被共享相邻 label 规则添加 15px margin-top；参考同排。修复：显式重置 grid 直接字段间距。
- [P2] 主要标题、任务文字与元数据的整体尺度偏小，降低任务区的可读性；连接启用状态另占一行，使连接卡片较高。修复：渠道内调整字号层级与连接状态位置，不影响其他设置页。

## Required fidelity surfaces

- 字体：保留 Lake 的系统中文字体与共享字号体系；正在修正渠道内标题 / 正文 / 元数据层级。
- 间距与布局：主从栏宽度已匹配；上述高度与字段对齐仍需复拍。
- 颜色：使用现有深浅主题 token；参考的紫色选中层按 Lake 中性选中 token 实现，作为有意的产品一致性差异。
- 图像与图标：界面不包含新插画；使用既有 Glyph 图标，不引入 emoji 或手绘资产。背景专员头像属于现有工作台。
- 文案：保留连接、项目、路由、来源消息、专员及任务层级；「已收到 1 / 2 份报告 · 仍在处理」来自真实状态，避免把查询结果写为远端已经收到。

完整图已能辨认字段错位与主要层级；修复后将补充控件 / 任务区域、浅色及窄窗证据，并验证主要交互与控制台。

第二次比较：`dark-desktop-second.png`，已安装 Dev `c5d15701`。940px 高度、字段对齐与字号层级已修复；相同状态下页脚 bottom 990.98px 超过弹窗 bottom 981px，仍为 P2。已压缩详情与分组的纵向间距，浏览器临时样式预览显示页脚完整进入首屏；临时样式截图不作为最终通过证据。另将连接卡片统一到 14px 面板圆角。下一次比较须使用重新安装后的资产。

## Implementation checklist

- 修复三个 P2，构建新的签名 Lake Dev。
- 同 viewport 复拍并比较，检查深浅 / 窄窗 / 控件状态及真实任务跳转。
- 记录证据与测试结果，恢复日常 Dev。

final result: blocked
