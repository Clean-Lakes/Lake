Lake v0.3.14：修复回复结束状态与 Windows SSH 凭据助手。

- 修复模型已经输出完整回复、会话仍一直显示“正在生成回复”的问题。收到协议结束标记后及时完成；OpenAI 兼容接口最多额外等待一秒接收用量，不再一直等待服务端关闭连接。
- 对已有部分输出但连续一分钟没有进展的模型流，结束等待并保留收到的内容，提示继续对话；停止操作与工具调用校验保持有效。
- Windows 桌面端的 SSH 密码与私钥口令助手改用包内控制台程序，避免 GUI 程序的输出管道影响凭据传递。覆盖包含中文、空格的安装路径与凭据路径。
- SSH 在初始化前退出时显示安全的退出码，区分认证失败、缺少运行库、架构不符与初始化失败，便于排查连接问题。
- 新增 Windows 实际打包后的连接测试，使用安装包内的 OpenSSH 与凭据助手完成密码认证；同时验证回复结束后可继续发送下一条消息。

## 下载与安装

- macOS：Apple Silicon（M 系列）arm64，macOS 13+。提供 DMG、ZIP 和 SHA-256；将 Lake.app 安装到 Applications。
- Windows：Intel / AMD x86_64，Windows 10 1809+ / Windows 11。提供安装 EXE、免安装 ZIP 和 SHA-256，内置 Bash 与 SSH，无需 Node.js 或 WSL。安装版缺少 WebView2 时会验证 Microsoft 签名并安装官方运行环境，首次补装需要联网。

更新保留模型配置、会话、资源和凭据；重启会关闭当前终端连接，不自动重放历史命令。macOS 与 Windows 的旧正式版均可检测更高版本更新。

macOS 包使用持久 Lake Local Development Code Signing 证书签名，尚未使用 Apple Developer ID 公证。Windows 应用暂未配置 Authenticode 签名。Windows 包由 Windows CI 构建，验证存储、权限、原生终端、流式回复结束与包内 SSH 凭据助手；远端服务器的具体配置仍可能影响连接。
