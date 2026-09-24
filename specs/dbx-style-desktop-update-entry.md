# DBX 风格桌面更新入口

## 目标

将桌面自动更新能力改为接近 DBX 截图的标题栏入口：更新可用时，在工作区 Header 右侧操作区显示一个中性的云下载图标；不再使用左侧绿色胶囊和展开文案。Lake 的发布与更新源改为 GitHub Release，首个 macOS arm64 版本为 `v0.0.1`。

## 产品规则

- 仅桌面端参与自动更新；Web 和手机远控不新增更新入口。
- `idle`、`checking` 或没有可展示版本时不显示图标；用户仍可从帮助菜单手动“检查更新”。
- `update-available` 显示云下载图标，Tooltip 说明目标版本，点击打开现有独立更新窗口。
- `download-progress` 在同一位置显示旋转加载图标，Tooltip 展示版本或下载量，点击仍打开更新窗口以查看或取消下载。
- `update-downloaded` 恢复云下载图标，Tooltip 表示可重启安装，点击打开更新窗口。
- 普通聊天/草稿工作区将入口放在 `WorkspaceHeader` 右侧操作区；没有该 Header 的 Automations、插件中心、湖目录等主视图继续由 `DesktopTopOverlay` 承载兜底入口，保证更新状态仍可访问。
- 图标按钮使用现有 Header ghost 按钮尺寸、主题 token 和 `text-ui-*` 体系；不使用固定绿色底色，也不显示常驻短文案。
- 正式包启动后立即检查一次更新；空闲或已有已下载版本时每 5 分钟重新检查。检查或下载进行中不并发发起重复请求。
- 正式稳定版固定读取 `https://github.com/Clean-Lakes/Lake/releases/latest/download/latest-mac.yml`，不接受环境变量或启动参数把已安装应用改到其他更新源；开发态仍可显式覆盖以便联调。
- GitHub Release 必须同时发布 `latest-mac.yml`、`Lake-<version>-mac-arm64.zip`、ZIP blockmap 与 `Lake-<version>-mac-arm64.dmg`。自动更新下载 ZIP，DMG 供首次安装或手动恢复。
- manifest 中的相对资源路径以 manifest 所在的 GitHub Release 下载目录为基准解析，不能回退到 `github.com/` 根路径。
- 点击入口继续复用现有流程：打开更新窗口、用户确认下载、下载完成后点击“重启以更新”，由 `electron-updater` 退出并覆盖当前应用。

## 状态与所有权

- 权威状态：`packages/desktop/src/main/autoUpdater.ts` 中的 main 进程更新状态机。
- Renderer 投影：`useAppChromeState` 订阅 `getUpdateState` / `onUpdateStateChanged`，只保存当前窗口的显示快照。
- UI 草稿：只有独立更新窗口的打开态和按钮操作 pending；不成为更新事实来源。
- 持久化：继续复用现有自动下载偏好、跳过版本与安装后说明记录；本变更不新增持久化字段。

```text
electron-updater 事件
  -> main autoUpdater（唯一状态所有者）
  -> UpdateState IPC 广播 / getUpdateState 快照
  -> useAppChromeState（窗口显示投影）
  -> WorkspaceHeader 右侧入口 / 特殊页面顶部兜底入口
  -> 现有 openUpdateStatusWindow / download / cancel / quitAndInstall 命令
  -> main autoUpdater
```

```text
Lake 启动 / 5 分钟轮询
  -> GitHub latest-mac.yml
  -> 发现高于本机版本
  -> Header 云下载入口
  -> 下载 Release ZIP + blockmap
  -> update-downloaded
  -> 用户点击重启更新
  -> quitAndInstall 覆盖应用并重启
```

## 不变量与失败语义

- 不在 UI、Zustand 或 Host 中复制更新状态机。
- 点击入口只打开状态窗口；下载、取消和安装仍由现有 main IPC 处理。
- 初始状态查询慢于状态事件时，事件 revision 继续阻止旧快照覆盖新状态。
- 打开独立窗口失败时不乐观改变更新阶段；后续仍可从帮助菜单重试。
- Desktop 更新流不得进入 Web 或手机的 replayable 会话链路。
- manifest 请求失败只记录错误并恢复可重试状态，不退出应用，也不清除已下载且可安装的版本。
- 发布资产应先上传安装包、ZIP 和 blockmap，最后上传 `latest-mac.yml`，避免客户端看到尚未完整可下载的版本。
- 保留与更新无关的 Header 操作顺序、窗控安全区和现有本地修改。

## 验收场景

| 场景          | 准备                       | 操作                             | 断言                                            | 证据                       |
| ------------- | -------------------------- | -------------------------------- | ----------------------------------------------- | -------------------------- |
| 无更新        | `idle`                     | 打开普通工作区                   | Header 无更新图标；帮助菜单仍有检查更新         | 纯函数测试 + 桌面手验      |
| 发现更新      | `update-available`         | 打开普通工作区                   | 右侧操作区出现云下载图标，无绿色胶囊和展开文字  | 纯函数测试 + 桌面截图      |
| 查看更新      | `update-available`         | 点击云下载图标                   | 打开现有独立更新窗口，版本一致                  | 桌面 E2E/手验              |
| 下载中        | `download-progress`        | 观察并点击入口                   | 原位置显示 spinner；窗口可查看进度和取消        | 纯函数测试 + 桌面 E2E/手验 |
| 已下载        | `update-downloaded`        | 点击入口                         | Tooltip/窗口提示重启安装                        | 纯函数测试 + 桌面 E2E/手验 |
| 特殊页面      | 任一可见更新态             | 打开 Automations/插件中心/湖目录 | 顶部兜底入口仍存在且可打开更新窗口              | 路由测试 + 桌面手验        |
| GitHub 更新源 | 本机版本低于 Release       | 启动应用或等待一次轮询           | 请求固定 manifest，图标在结果返回后立即出现     | URL 单测 + 桌面手验        |
| 相对下载路径  | manifest 使用相对 ZIP 路径 | 点击下载                         | ZIP 从同一 `releases/latest/download/` 路径下载 | URL 单测 + 下载手验        |
| 覆盖安装      | ZIP 下载并完成 staging     | 点击“重启以更新”                 | 退出、覆盖旧应用、重启到新版本                  | 签名发布包手验             |

当前仓库没有独立桌面更新 E2E runner；实现应提供可自动执行的状态/放置测试，并把真实 BrowserWindow 点击流程保留为发布前桌面手验项。
