# 工作区轻量底部入口

2026-10-30，按用户确认的方案，将工作区入口改为常态透明、无可见描边或阴影，悬停/键盘焦点显示主题浅底，展开时使用选中底色。共享Glyph新增四格workspace图标（本地lucide LayoutGrid），菜单设置项继续使用齿轮。按钮44px点击高度、共享窗口曲线、图标距侧栏左边12px、右侧箭头保留，底部留白8px。

移除工作区玻璃材质层。入口在侧栏flex布局中独占底部44px区域，资源滚动区与入口分离；列表底部留白由72px改为16px，保留滚动余量且不让文字滚到透明入口背后。工作区菜单仍向上展开，与入口等宽。标签筛选、更新红点、菜单页切换及权限/数据逻辑不改。

本地验证：

- Node24/pnpm前端549/549、TypeScript与Web构建通过；既有大chunk提示保留。无Go/API/持久化变化，未重复Go回归。
- 实际App隔离fixture：默认background/border均透明、box-shadow=none、无glass节点；按钮高44px、底部8px、图标left=12px，已查看深色默认与悬停截图。
- 菜单向上展开、与按钮等宽且在视口内，Escape关闭并恢复入口焦点。鼠标可展开16条会话并再次收起；列表最后一个实际树行完整处于滚动视口内，且与入口无交叠。
- 420×760浅色窗口与原生圆角兼容模式：入口高度44px、底部8px、图标left=12px，无横向溢出，悬停曲线无方形背板；菜单向上、等宽且在视口内。

已查看 `/tmp/lake-light-workspace-dark.png`、`/tmp/lake-light-workspace-dark-hover.png`、`/tmp/lake-light-workspace-light-fallback.png`。fixture仅使用虚构会话/资源，无真实模型或资源命令。原生CUA既有超时限制沿用，不宣称原生自动化截图通过。签名Lake Dev准确来源、当前服务JS/CSS摘要及未验证项记录于对应PR。

回退本次前端提交即可恢复旧入口；无需迁移或删除用户数据。
