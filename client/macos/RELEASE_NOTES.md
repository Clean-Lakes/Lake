Lake 0.3.7：会话目标、Agent 调查和桌面工作台改进。支持 Apple Silicon（M 系列）arm64，macOS 13 及以上。

- 修复用户确认资源目录和主机范围后，调查仍被旧的“待澄清”状态拦截的问题；已确认的主机集合在后续追问中保持准确，不会混入同目录的数据库。
- 改进 SSH 连接失败、主机指纹确认、终端复用与命令审批，减少连接中断和目标切换时的错误。
- 完善 Agent 工具、调查结果、会话上下文与提问交互，并调整项目、资源和会话的工作台界面。
- 改进客户端更新检查和安装后的清理流程。本安装包为正式版 Lake.app，使用正式 bundle ID，不带 DEV 标识。

更新保留 ~/.lake 中的模型配置、会话、资源和凭据。重启时会关闭当前终端连接，不自动重放历史命令。

安装：下载 Apple Silicon DMG，将 Lake.app 拖入 Applications；也可解压 ZIP 到用户 Applications 目录。安装包使用持久 Lake Local Development Code Signing 证书签名，尚未使用 Apple Developer ID 公证。首次安装可能需要在 macOS 系统设置中允许打开；自动更新只接受使用同一证书签名的安装包。
