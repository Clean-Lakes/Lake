Lake 0.3.5：原生 macOS 客户端与内置 Go/React 工作台更新。支持 Apple Silicon（M 系列）arm64，macOS 13 及以上。

- 新增项目记忆基础版：同项目会话可共享长期约束与参考信息；支持查看、编辑、忘记和停用，成功回复后可在后台提取候选记忆。单轮忽略选项移至“设置 → 对话 → 当前会话”，发送后自动取消。
- 浏览器工作台支持直接粘贴 PNG、JPEG、GIF、WebP 图片并预览；模型未启用图片输入时会阻止发送并提示切换模型。
- 支持编辑会话名称以及本机、SSH 资源的终端配置；改进资源导入与本机 HexHub 连接同步。
- 改善长对话的上下文整理、证据分页和中断恢复，优化 Agent 调查进度、回复耗时与错误提示。
- 更新应用图标和界面细节。

更新保留 ~/.lake 中的模型配置、会话、资源和凭据。重启时会关闭当前终端连接，不自动重放历史命令。

安装：下载 Apple Silicon DMG，将 Lake.app 拖入 Applications；也可解压 ZIP 到用户 Applications 目录。安装包使用持久 Lake Local Development Code Signing 证书签名，尚未使用 Apple Developer ID 公证。首次安装可能需要在 macOS 系统设置中允许打开；自动更新只接受使用同一证书签名的安装包。
