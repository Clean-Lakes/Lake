# Lake 环保主题（湖泊/森林色系）

状态：本产品主题，同时保留上游 Zai 两套主题
影响面：`packages/ui`（Desktop / Web / 手机远控共用）、`packages/desktop` renderer 启动引导、`packages/web` 初始主题

## 产品规则

1. 新增两套主题：`lake-dark`（默认）与 `lake-light`，构成"环保"视觉基调。
2. 品牌色 = 湖水 teal（深色 `#2dd4bf` / 浅色 `#0d9488`）；成功与新增语义保留绿色（深色 `#4ade80` / 浅色 `#16a34a`）。
   **teal 只承担品牌、选中、聚焦与重命名等身份语义，green 只承担成功/新增**，两者不得互换。
3. 上游 Zai 两套主题（`zai-light` / `zai-dark`）继续可选、可用，不删除；`light`/`dark` 两个裸值在归一化时收敛到 `lake-*`。
4. 默认主题：新安装（无 localStorage `zcode-theme`）使用 `lake-dark`；已有用户保存的选择不被覆盖。

## 状态与所有者

- 颜色的唯一真相源仍是 `packages/ui/src/styles.css`：本次新增 `.theme-lake-dark` 与 `.theme-lake-light` 两个覆盖块，逐项覆盖 `@theme` 里的 token 名，**不新增 token 名、不改组件**。
- 主题状态所有者不变：`packages/ui/src/store/index.ts` 的 `theme` + `setTheme`（`BROADCAST_FIELDS` 里继续广播），`packages/ui/src/useTheme.ts` 的 `applyTheme()` 是唯一 class 写入点。
- 派生入口同步：`packages/web/src/webThemeSeed.ts`（web 首屏）、`packages/desktop/src/renderer/src/main.tsx`（桌面首屏，避免 hydration 前闪错主题）、`packages/ui/src/settings/settingsPageConfig.ts`（设置里可选）。

## 接口

- `Theme` 联合类型扩展为：`light | dark | zai-light | zai-dark | lake-light | lake-dark | system`。
- `<html>` 上的 class：`.theme-lake-dark` / `.theme-lake-light`（与既有 `.theme-zai-*` 同一机制，`.dark` 仍表示暗色以驱动 `dark:` 变体）。
- `normalizeThemePreference`：`dark → lake-dark`、`light → lake-light`；`resolveTheme` 把 `lake-dark` 判为暗色。

## 验收场景

1. 设置 → 外观里出现 5 个选项（系统 / 环保·深色 / 环保·浅色 / Zai 深色 / Zai 浅色，英文 Eco Dark/Eco Light），切换后整界面即时换色。
2. 清空 localStorage 后重启：默认进入环保·深色；切到环保·浅色时面板/卡片/边框/文本层级仍然成立（不出现浅底白字）。
3. 终端面板：`--color-terminal-*` 全部为可直接解析的颜色（本主题未使用嵌套 `color-mix()`），xterm 能取到 ANSI 16 色。
4. 打开工作区页（hero 渐变）：环保两套主题有对应配色分支，不落到通用 dark/light 兜底。
5. Zai 两套主题行为与本改动前一致。

## 实测对比度（2026-09-21，渲染进程内 canvas 合成后测量）

| 配色对 | lake-dark | lake-light | 上游 zai-dark | 上游 zai-light |
| --- | --- | --- | --- | --- |
| foreground / background | 14.91 | 10.81 | 12.21 | 14.25 |
| foreground-subtle / background | 6.18 | 4.49 | 5.04 | 4.04 |
| foreground-subtlest / background | 2.70 | 2.15 | 2.21 | 2.35 |
| primary-foreground / primary | 9.18 | 11.48 | 21.00 | 21.00 |
| brand / background | 10.02 | 5.20 | 18.10 | 19.77 |
| success / background | 10.70 | 4.76 | 7.72 | 4.15 |
| destructive-foreground / destructive | 3.98 | 4.83 | 3.03 | 4.51 |

结论：正文与次级文本、品牌色、成功/危险语义色在环保两套主题下均不低于上游同项，且 `lake-light` 的 success/destructive/brand 优于 `zai-light`。
唯一已知取舍：`lake-dark` 的危险按钮标签（白字压在 `#e04b4b` 上）为 3.98:1，低于 4.5 但高于 WCAG 1.4.11 对 UI 组件的 3:1 要求，且优于上游 3.03；同一 token 作为错误文本压在暗底上是 4.69:1（达 AA）。若后续更看重按钮标签，把 `--color-destructive` 换成 `#d93a3a`（标签 4.55、文本 4.10）即可，但会牺牲错误文本可读性。
`foreground-subtlest` 是设计上最弱的一级（用于极弱提示），两套主题与上游同量级。

## 实现踩到的坑（新增主题时必读）

新增一套主题不只是"加两个色块"，**取值校验点散落在多处**。首次实现时漏了下面两处，导致"设置里能选、点了没反应"：

1. `packages/ui/src/SettingsPage.tsx` 的 `handleFooterThemeChange` 曾自建一份 `value === "light" || "zai-light" || ...` 白名单，不在名单里的值被**静默丢弃**——设置 → 外观的下拉走的就是这里。
2. `packages/ui/src/WorkspaceSidebar.tsx` 的 `handleThemeChange` 有同样的第二份白名单，侧边栏的主题子菜单走的是它。侧边栏菜单项当时也只列了 Zai 两项，已补上环保两项。

现在两处都改为调用 `packages/ui/src/useTheme.ts` 导出的 `isThemePreference()`，**新增主题只改这一个校验入口**。

同一类遗漏还修了三处"主题取值枚举"：

- `packages/ui/src/test-actions.ts` 的 `setTheme` 类型（E2E 钩子）收敛为 `Theme` 类型本身。
- `packages/ui/src/components/ai-elements/mermaid-block.tsx` 的 SSR 兜底判断补上 `lake-dark`（否则 Mermaid 图会在环保深色下用浅色主题渲染）。

排查方法（下次加主题可复用）：把 `localStorage` 的 `zcode-theme` 写入打上探针，或者直接在 DevTools 里选一次主题看 `localStorage` 是否变化——**值没写进 `localStorage` 就说明被校验点拦下了，而不是 CSS 没生效**。

## 不覆盖 / 后续注意

- 产品文案与应用展示名另见 `specs/lake-product-language.md`；图标资产及上游版权归属不在配色主题改动内。
- 未改：CLI/TUI 主题（`apps/zcode-cli/packages/tui/src/theme/` 是另一套独立体系）。
- 已知需在后续主题迭代里单独处理：`packages/ui/src/settings/StatusDot.tsx` 用 Tailwind `*-500` 而非语义 token，`packages/ui/src/components/ui/chart.tsx` 内有 `#ccc` 选择器。
- 同步上游时：`styles.css` 的两个新色块是纯增量；但 `useTheme.ts`、`store/index.ts`、`webThemeSeed.ts`、desktop renderer 引导四处改了默认值，上游若调整主题入口需重新合并。
