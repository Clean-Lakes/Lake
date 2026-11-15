# 接入渠道设计验证

- Source visual truth：[用户选定渲染图](docs/validation/typescript-candidate/incoming-channels/design-reference.png)，1538 × 1022。
- Final implementation：[深色桌面](docs/validation/typescript-candidate/incoming-channels/dark-desktop.png)、[浅色桌面](docs/validation/typescript-candidate/incoming-channels/light-desktop.png)，签名安装 Lake Dev `97a3bd6de1d516bfc3737d7e2857464a75dd5531`，没有样式注入。
- 比较 viewport：1538 × 1022 CSS px、deviceScaleFactor 1；参考与实现均为 1538 × 1022，无密度缩放，在同一图片输入中比较。窄窗为 390 × 844 CSS px、deviceScaleFactor 1。
- 对齐状态：深色、三条连接、选中「我的 Codex」、最近消息关联两项任务，一份报告已提交、另一项运行中。项目名称、消息前缀和时间来自隔离测试数据；背景和浏览器没有 macOS 标题栏不作像素偏差。

## Findings / comparison history

1. `8a93b9f9`：[首次截图](docs/validation/typescript-candidate/incoming-channels/dark-desktop-initial.png) 存在三个 P2：760px 弹窗使汇总 / 底部控件落在首屏外；共享 label 规则造成路由字段 15px 错位；字号层级偏小且连接状态另占一行。已调整渠道内高度、字段间距、字号和状态位置。
2. `c5d15701`：[第二次截图](docs/validation/typescript-candidate/incoming-channels/dark-desktop-second.png) 修复上述问题，但页脚 bottom 990.98px 超过弹窗 bottom 981px，仍为 P2。已压缩详情及分组纵向间距，连接卡片统一为 14px 面板曲线。
3. `3c238995`：实际重新安装后，页脚 bottom 937.98px、管理入口 bottom 976.48px 均处于弹窗内部；明暗与窄窗通过。键盘实测另发现 P2：Chromium 关闭的 details 子按钮仍有非零 rect，误入焦点列表，Tab 可跳入背景。已补显式过滤及回归。
4. `97a3bd6d`：最终安装版重拍并验证。视觉问题保持修复；收起和展开管理区均正确环绕焦点，Escape 仅关闭下拉，未改变路由或关闭设置。独立只读复核确认最终截图与结构化证据一致。

没有未解决的 P0、P1 或 P2。

## Required fidelity surfaces

- 字体：保留 Lake 系统中文字体；渠道标题、任务正文与元数据层级已调整，深浅主题和窄窗均清晰可读。
- 间距与布局：1248 × 940 弹窗、420px 左栏；两项字段同排对齐。来源消息 → 任务 → 报告汇总和底部操作在桌面首屏完整显示；390px 窄窗上下堆叠，任务区域 width / scrollWidth 均为 300px，无横向溢出。
- 颜色：沿用已有深浅主题 token。参考的紫色玻璃 / 选中层使用 Lake 中性表面与选中 token，是有意保持产品一致性的差异；状态色区分执行中与报告已提交。
- 图像与图标：使用共享 Glyph，无新插画或 emoji 占位。背景头像属于已有工作台。卡片、控件与菜单沿用共享圆角和 superellipse；实际观察焦点、悬停、选中及边缘裁切正常。
- 文案：保留连接、项目、路由、来源消息、专员及现有任务的层级。汇总使用「已收到 1 / 2 份报告 · 仍在处理」，完成后显示两份报告，不声称远端已阅读或必然生成额外总结。保留现有巡检、实验记忆等设置入口。

## Visible states and interactions

- [深色窄窗](docs/validation/typescript-candidate/incoming-channels/dark-narrow.png)、[窄窗任务](docs/validation/typescript-candidate/incoming-channels/dark-narrow-tasks.png)、[浅色窄窗任务](docs/validation/typescript-candidate/incoming-channels/light-narrow-tasks.png)：标题与内容换行、滚动、曲线与裁切通过。
- [路由菜单](docs/validation/typescript-candidate/incoming-channels/dark-routing-menu.png)、[悬停](docs/validation/typescript-candidate/incoming-channels/dark-hover.png)：AppSelect 选中 / 焦点 / 悬停可见，ArrowDown 与 Escape 行为正确。
- [完成状态](docs/validation/typescript-candidate/incoming-channels/dark-complete.png)：在先前 1/2 截图之后释放第二个 Worker，状态由 running 变为 replied，两份报告完整出现。
- [任务详情](docs/validation/typescript-candidate/incoming-channels/task-detail.png)：任务行打开准确项目、Task 和执行 Session，不生成第二套任务。
- [原生截图](docs/validation/typescript-candidate/incoming-channels/native-installed.png)：已安装原生 WebKit 实际显示任务与底部区域；保留屏幕密度，不与 DSF 1 参考作像素对齐。
- 创建 / 重命名 / 启停 / 删除连接、复制配置、只读测试、旧凭据创建与吊销、最新消息 / 历史展开均通过。最终键盘与控制台记录见 [keyboard-checks.json](docs/validation/typescript-candidate/incoming-channels/keyboard-checks.json)、[final-ui-checks.json](docs/validation/typescript-candidate/incoming-channels/final-ui-checks.json)，控制台错误为 0。

已完成修复、签名安装、同尺寸比较、明暗 / 窄窗 / 控件状态、真实任务跳转与键盘验证。日常 Dev 已恢复。测试环境和收尾限制见 [完整验证报告](docs/validation/typescript-candidate/incoming-channels-2026-11-15.md)。

final result: passed
