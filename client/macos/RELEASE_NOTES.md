Lake v0.3.15：改善 Windows SSH 认证兼容性与连接失败诊断。

- 修复 Windows 终端可能继承旧 SSH 凭据助手或连接环境的问题，确保使用当前连接的账号和已保存凭据，兼容中文、空格路径。
- 密码登录兼容 keyboard-interactive/PAM 密码提示；私钥登录仍仅使用公钥认证，不自动退回密码认证。
- SSH 初始化失败时显示实际连接账号、目标和安全的失败原因，区分认证被拒绝、凭据助手异常、远端关闭连接及远端命令拒绝。
- 改善 Windows ConPTY 提前退出时的诊断保留。启动日志使用私有临时文件，结束后删除，仅保留固定错误分类。
- Windows CI 使用实际打包后的 OpenSSH 和凭据助手，验证密码认证、PAM、中文和空格路径、旧环境覆盖及编辑连接凭据等场景。

## 下载与安装

- macOS：Apple Silicon（M 系列）arm64，macOS 13+。提供 DMG、ZIP 和 SHA-256；将 Lake.app 安装到 Applications。
- Windows：Intel / AMD x86_64，Windows 10 1809+ / Windows 11。提供安装 EXE、免安装 ZIP 和 SHA-256，内置 Bash 与 SSH，无需 Node.js 或 WSL。安装版缺少 WebView2 时会验证 Microsoft 签名并安装官方运行环境，首次补装需要联网。

更新保留模型配置、会话、资源和凭据；重启会关闭当前终端连接，不自动重放历史命令。macOS 与 Windows 的旧正式版均可检测更高版本更新。

macOS 包使用持久 Lake Local Development Code Signing 证书签名，尚未使用 Apple Developer ID 公证。Windows 应用暂未配置 Authenticode 签名。Windows 包由 Windows CI 构建，验证存储、权限、原生终端、流式回复结束与包内 SSH 凭据助手；远端服务器的具体配置仍可能影响连接。
