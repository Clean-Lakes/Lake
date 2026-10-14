Lake 0.3.8：Magpie 模型接入与模型设置改进。支持 Apple Silicon（M 系列）arm64，macOS 13 及以上。

- Magpie 接入后，Lake 的模型设置和聊天输入区可搜索、选择 Magpie 提供的多个模型；Magpie Agent 页面仍用于设置默认模型。
- 模型设置中展示 Magpie 标识和模型来源，并保留 Lake 内当前的 Magpie 模型选择。
- 完善 Lake Dev 独立联调流程；正式版和 Dev 使用不同的应用、数据目录及凭据。本安装包为正式版 Lake.app，使用正式 bundle ID，不带 DEV 标识。

更新保留 ~/.lake 中的模型配置、会话、资源和凭据。重启时会关闭当前终端连接，不自动重放历史命令。

安装：下载 Apple Silicon DMG，将 Lake.app 拖入 Applications；也可解压 ZIP 到用户 Applications 目录。安装包使用持久 Lake Local Development Code Signing 证书签名，尚未使用 Apple Developer ID 公证。首次安装可能需要在 macOS 系统设置中允许打开；自动更新只接受使用同一证书签名的安装包。
