# 客户端启动不再弹账号连接页

状态：本地定制（相对上游 ZCode 的有意偏离，标记为临时）
影响面：`packages/ui`（Desktop / Web 共用）

## 产品规则

1. 客户端启动时，不再因为"未连接账号 / 没有可用 provider"而把首屏切到账号连接页（`WelcomeScreen`，文案 `login.title`）。用户直接进入工作区。
2. 账号连接页本身不删除：用户在设置里主动发起登录、退出登录后的重新连接、以及 JWT 过期提示这三条路径仍然打开它。本次只关掉**启动阶段由 provider 可用性自动触发**的那一条。

## 状态与所有者

- 单一所有者：`packages/ui/src/Root.tsx` 的 `welcomeScreenOpenReason`（`useState`）。它是"当前是否展示 WelcomeScreen"的唯一事实源，取值即打开原因。
- 闸门开关：`packages/ui/src/lib/rootStartupGate.ts` 的 `shouldEnableProviderAvailabilityLoginEntryGuard()`。
  - 返回 `true`（上游行为）：`useProviderAvailabilityLoginEntryGuard` 生效，启动检查完成后按
    `shouldOpenLoginEntry = !providerFamilyDomain || (!user && !hasUsableProvider)` 写入 `welcomeScreenOpenReason = "startup-provider-required"`。
  - 返回 `false`（本定制）：守卫 `enabled=false`，不写入任何 reason，启动登录态始终为空。
- 依赖方向不变：`Root.tsx` 只读该纯函数，未新增状态、未新增写入路径，也没有第二条"是否登录"的判断。

## 事件顺序

```
启动 → provider family domain 迁移（finally 中无条件置 complete）
     → modelSelectionView 水合
     → shouldResolveProviderStartupState 结束
     → canRestoreWorkspaceSession = true → 恢复工作区
```

守卫被禁用后，`startupCheckCompleted` 立即为 `true`，`isResolvingProviderStartupState` 只依赖迁移与水合两项，两者都不依赖登录，因此不会停在启动 loading。

## 验收场景

1. 全新数据目录（无账号、无 `providerFamilyDomain`）启动客户端：不出现"欢迎来到 ZCode"，直接进入工作区；`syncLoginEntryWithProviderAvailability` 不把 `welcomeScreenOpenReason` 置为 `startup-provider-required`。
2. 数据目录里已配置 `provider_config.json`（api-key 类型 provider）：同样直接进入工作区，模型列表可用。
3. 设置里主动登录 / 手动登录入口：仍能打开 WelcomeScreen（该路径不经守卫）。
4. 未提供任何 provider 配置的极端情况：进入工作区，模型列表为空；不再引导连接账号——这是本定制接受的代价。

## 不覆盖 / 后续注意

- 不改 logout、会话过期（`session-expired`）两条路径。
- 不触碰上游的 provider 可用性判定 `resolveProviderAvailabilityState` 与迁移逻辑。
- 同步上游时注意：本改动只在 `shouldEnableProviderAvailabilityLoginEntryGuard()` 一个断言上，若上游在该函数或其调用点引入新语义（例如用它承载其它门禁），需要重新评估。
