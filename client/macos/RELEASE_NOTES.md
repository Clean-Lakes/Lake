原生 macOS 客户端，内置当前 Go 后端与 React 工作台，仅支持 Apple Silicon（M 系列）arm64，macOS 13 及以上。

- 右上角新增更新检测图标，启动时及每 5 分钟检查 Clean-Lakes/Lake 的 master 正式 Release。
- 标题栏与侧栏、工作台融为一体，右上角原生更新入口在复用旧 Web 服务时也始终可见。
- 发现新版本后，点击“下载并重启更新”自动下载安装包、校验、替换并重新打开应用。
- 校验 SHA-256、版本、应用 ID 和同一签名证书；安装失败或新版本无法启动时恢复原版本，成功后保留旧应用备份。
- 模型、会话、资源和凭据仍保存到原有 ~/.lake；更新不会重新执行历史命令，重启会关闭终端连接。

安装：下载 Apple Silicon DMG，拖动 Lake.app 到 Applications，也可以解压 ZIP 到用户 Applications 目录。旧 Electron 客户端请首次手动安装此版本，其更新协议和数据结构不同。

本次使用持久 Lake Local Development Code Signing 本地证书签名，尚未使用 Apple Developer ID 公证。首次安装可能需在 macOS 系统设置中允许打开。自动更新仅接受与当前客户端使用同一证书签名的安装包。
