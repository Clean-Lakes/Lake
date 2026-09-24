# 升级套餐页整页下线

状态：本地定制（相对上游 ZCode 的有意偏离）
影响面：`packages/ui`（Desktop / Web / 手机远控共用）
上位规格：`specs/vendor-config-removal.md`（下线 Z.ai / BigModel 厂家内容）——本文件补齐其中「编程套餐」一项的落地做法。

## 产品规则

1. 「升级套餐」页不再渲染，任何入口都无法打开它。该页本质是 webview 打开厂家官网 `/coding-plan` 购买页，本产品不接厂家账号，页面没有可用前景。
2. 当前仍可见的升级入口一并去掉，避免留下点了没反应的死按钮：
   - 侧边栏头像菜单的「升级套餐」；
   - 无可用模型错误横幅上的「升级套餐」；
   - 闲时任务的套餐门槛提示不再带跳转动作（提示文案保留）。
3. 不改动的东西：「使用统计」入口、设置页「模型设置」（自定义供应商）、闲时任务自身的套餐判定与文案。

## 机制与所有者

| 关注点             | 位置                                           | 做法                                                                                                                                                                             |
| ------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面与厂家套餐查询 | `settings/CodingPlanUpgradeDialogProvider.tsx` | 本地定制下走常量上下文分支：不调用 `useCodingPlanEntryPlanList`（即不请求厂家套餐/企业价格）、不渲染 `CodingPlanUpgradeDialog`、`openCodingPlanUpgrade` 恒返回 `false`（未打开） |
| 开关               | `lib/codingPlanUpgradeGate.ts`                 | `shouldEnableCodingPlanUpgrade()` 返回 `false`；改回 `true` 即恢复上游行为                                                                                                       |
| 侧边栏头像菜单入口 | `WorkspaceSidebarFooterUsageSummary.tsx`       | 不再渲染「升级套餐」菜单项；`onUpgradeClick` prop 保留为接缝（类型不变，调用方仍传）                                                                                             |
| 无可用模型横幅入口 | `ChatErrorBanner.tsx`                          | `modelConfigMissing` 分支只保留「设置模型」；`onOpenUpgrade` prop 保留为接缝                                                                                                     |
| 闲时任务套餐提示   | `settings/AutomationsSection.tsx`              | 提示文案保留，去掉「升级套餐」动作，不再持有入口闸门与升级上下文                                                                                                                 |

状态所有者不变：升级页可见性原本由 Provider 内 `target` state 唯一决定。本次是让 Provider 在本地定制下不进入这套状态机——没有新增状态，也没有第二条写入路径。

上下文契约不变：`useCodingPlanUpgradeDialog()` / `useOptionalCodingPlanUpgradeDialog()` 仍然可用（调用方无需判断是否挂载）。`inventory.status` 恒为 `ready`，避免入口按钮被误显示成「重试」；`inventory.retry` 为 no-op。

## 验收场景

1. 打开侧边栏头像菜单：没有「升级套餐」项，「使用统计」仍在且可打开设置页用量视图。
2. 制造无可用模型错误（例如清空模型配置后发送）：错误横幅只有「设置模型」，没有「升级套餐」。
3. 无 Coding Plan 时从闲时任务入口创建或点模板卡：出现「闲时任务仅向 Coding Plan 订阅用户开放。」提示，且提示上没有跳转升级的动作按钮。
4. 全应用不再出现 `coding-plan-upgrade-surface` 节点；冷启动不加载官网 `/coding-plan` 页面，也不发起厂家套餐/企业价格查询。
5. 设置页「模型设置」可正常查看与编辑自定义供应商；「使用统计」页行为不变。

## 不覆盖 / 后续注意

- 未删除（保留为接缝，只是不再渲染或打开）：升级页组件本体 `CodingPlanUpgradeDialog`、`CodingPlanEmbeddedWebviewDialog` 与其凭据注入/导航脚本；Desktop 主进程的 coding-plan webview 导航与分区清理（`desktopWindowChrome.ts`、`desktopCommandHandlers.ts`、`preload/codingPlanWebview.ts`）；模型设置页内的编程套餐面板（`model-provider-section` 内，已随预置分组一起不可达）；`SessionPane` 的会话额度横幅升级动作（需要厂家权益才会出现）。
- 未改 i18n key（`settings.modelProvider.codingPlan.*`、`chat.quota.action.upgrade`、`sidebar.usage.plan.upgrade` 等）：只是文案数据，删除会牵动两份 locale 文件，对行为无影响。
- 验收 4 的边界：本次只保证**升级页与入口**不再产生请求。实测（`pnpm dev:web` 冷启动）服务侧仍会在启动时探测厂家套餐可用性——`packages/services` 的 `codingPlanProviderAvailability` 会请求 `zcode-plan/billing/balance`。它与升级页无关，属于服务侧「厂家可用性/登录态判定」的独立清理项，本次未动。
- 与验收 4 相关：`openCodingPlanUpgrade` 恒返回 `false`，调用方（如 `SessionPane` 的观察式打开）会得到「未打开」这个真实结果，不会误报成功。
- 恢复方式：`shouldEnableCodingPlanUpgrade()` 返回 `true`，并恢复上述三处入口的渲染。
