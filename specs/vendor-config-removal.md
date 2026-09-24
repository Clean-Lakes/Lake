# 厂家配置下线、保留自定义供应商

状态：本地定制（相对上游 ZCode 的有意偏离）
影响面：`packages/ui`（Desktop / Web / 手机远控共用）
替代：本文件取代早先的“模型设置页整体下线”方案——那版把自定义供应商配置一起摘掉了，不满足产品需要。

## 产品规则

1. **保留**模型设置页与「自定义供应商」配置：用户用自己的 API Key 接入任意供应商。
2. **下线**所有 Z.ai / BigModel 相关内容：账号登录入口、预置分组（智谱 / Start Plan）、编程套餐、以及添加供应商时的智谱 API Key 模板。
3. 连接页（欢迎页）不再提供厂商 OAuth 按钮，只保留「使用 API key」路径。

## 机制与所有者

| 关注点         | 位置                                                            | 做法                                                                                                                                                   |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 设置分区可见性 | `lib/settingsNavigation.ts`                                     | 模型设置页**不**在 `HIDDEN_SETTINGS_SECTIONS` 里（页面恢复可见）                                                                                       |
| 页内分组       | `settings/model-provider-section/useModelProviderNavigation.ts` | 构建好的分组只输出 `custom`，编程套餐项不再追加进 `navigationItems`；预置分组的构建代码保留为接缝                                                      |
| 添加供应商模板 | `settings/model-provider-section/ProviderTemplatePicker.tsx`    | 去掉 `zhipu` 分组（`bigmodel-api` / `zai-api` / `bigmodel-standard-api` / `zai-standard-api`），只留通用模板                                           |
| 连接页厂商按钮 | `WelcomeScreen.tsx`                                             | `resolveVisibleLoginProviders()` 返回空数组                                                                                                            |
| 连接页整体     | `Root.tsx`                                                      | `shouldRenderWelcomeScreen = false`：连接页不再渲染（它剩下的「使用 API key」面板本身就是 Z.ai / BigModel 的提供方选择器）。状态机与页面代码保留为接缝 |
| 侧边栏账号入口 | `WorkspaceSidebarFooter.tsx`                                    | 未登录时不再显示「连接使用」文案（只保留头像与无障碍名称）；菜单里的登录项移除；`onLogin` prop 保留为接缝                                              |

状态所有者不变：模型供应商事实源仍是 provider 配置（`provider_config.json` / 内置目录），主题与语言偏好不变。

## Lake 模型配置的一次性迁移与持久化

- Lake 的模型配置权威文件是 `{dataBaseDir}/.lake/v2/provider_config.json`；ZCode 的对应文件只作为首次迁移的只读来源。任务、会话、项目及其他设置仍严格隔离，不随模型配置迁移。
- Host 启动 Provider Runtime 前，在 Lake 目标文件的同一文件锁内执行一次迁移。若 Lake 配置已有供应商、模型规则、排序或默认模型选择，保留 Lake 文件原样，不用 ZCode 覆盖；若 Lake 文件不存在或仅有空配置，且旧 ZCode 文件有效且非空，完整复制其个人供应商、模型规则、排序及默认选择。来源文件不修改、不删除。
- 迁移结果用 Lake 配置目录中的无凭据完成标记记录。即使用户日后主动删除全部供应商，重启也不得再次从 ZCode 导入。多窗口 Host 同时启动只有一个写入者；配置落盘后才写完成标记，崩溃重试不得覆盖已导入或后续编辑的数据。
- 旧文件无效时不写入 Lake，也不把无效内容当空配置；记录不含密钥的告警，保留源文件供修复。Lake 目标文件无效时保留原文件并交给现有恢复机制，不进行迁移覆盖。
- 新增或修改 Lake 供应商继续走现有 Provider Settings → Personal Provider Repository 原子写入链路，不产生第二份配置事实源；重启后从 Lake 文件恢复。

```text
ZCode provider_config.json ──只读──┐
                                  ├─ Host 启动迁移（Lake 目标文件锁）
Lake provider_config.json ──读写───┘      │
                                      原子写目标 → 完成标记
                                           ↓
                              Provider Runtime/Settings UI
```

验收场景：旧 ZCode 有模型而 Lake 为空时首次启动可见；Lake 已有模型时不被覆盖；导入后删除模型并重启不会复活；无效旧文件不污染 Lake；Lake 新建模型保存后重启仍存在；双 Host 并发只导入一次。

## 验收场景

1. 设置 → 模型设置存在；左侧只有「自定义供应商」分组，没有智谱 / BigModel / Start Plan。
2. 「添加供应商」只列通用模板，没有 Z.ai / BigModel 的 API Key 模板。
3. 任一自定义供应商可以正常查看/编辑/保存（API Key、Base URL、模型列表）。
4. 侧边栏底部的头像区不再出现「连接使用」；账号菜单里没有登录项。
5. 连接页（会话过期等路径触发）**不再出现**：即使写入 JWT 失效重启标记强制触发，也应直接进入工作区，页面上不再显示「连接 Z.ai / 连接 BigModel」及其 API Key 面板。
6. 模型下拉里「管理模型」仍可打开模型设置页。

## 不覆盖 / 恢复方式

- 未改：模型设置页组件本体与 coding-plan 相关 hooks 仍在运行（只是不再渲染对应分组）；`settings.modelProvider.*` 文案保留。
- 恢复单个部分：① 预置分组 → 去掉 `navigationGroups` 的 `filter`；② 智谱模板 → 恢复 `ProviderTemplatePicker` 的 `zhipu` 分组；③ 连接页按钮 → 恢复 `resolveVisibleLoginProviders` 的排序实现；④ 侧边栏登录项 → 恢复菜单项与 `getSidebarProfileBadge` 的未登录分支。
