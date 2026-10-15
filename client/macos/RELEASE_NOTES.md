Lake v0.3.12：修复模型切换后的上下文整理、MiMo 接入与思考级别菜单。

- 修复切换模型后，较长会话中的简短消息被误报“上下文超出配置预算”的问题；摘要按实际剩余空间调整，保留当前消息和原始操作记录，不重放已完成命令。
- “思考级别”统一使用公共下拉组件，与模型选择器保持无边框样式和图标对齐；修复选项散落在工具栏、换行错位的问题，支持键盘、窄窗口和深色主题。
- 修复小米 MiMo 切换 OpenAI / Anthropic 格式时地址前缀不匹配导致的 HTTP 404；官方地址随协议联动，并兼容已有配置。
- 统一 MiMo 对话、上下文摘要与模型列表获取的接口路由和认证方式，支持 OpenAI Chat Completions、Responses 与 Anthropic Messages。代理域名、自定义路径和端口保留用户配置。
- 上下文整理遇到接口不存在、鉴权失败、限流或渠道不可用时显示对应中文提示和恢复方法，保留会话历史。

## 下载与安装

- macOS：Apple Silicon（M 系列）arm64，macOS 13+。提供 DMG、ZIP 和 SHA-256；将 Lake.app 安装到 Applications。
- Windows：Intel / AMD x86_64，Windows 10 1809+ / Windows 11。提供安装 EXE、免安装 ZIP 和 SHA-256，内置 Bash 与 SSH，无需 Node.js 或 WSL。安装版缺少 WebView2 时会验证 Microsoft 签名并安装官方运行环境，首次补装需要联网。

更新保留模型配置、会话、资源和凭据；重启会关闭当前终端连接，不自动重放历史命令。macOS 与 Windows 的旧正式版均可检测更高版本更新。

macOS 包使用持久 Lake Local Development Code Signing 证书签名，尚未使用 Apple Developer ID 公证。Windows 应用暂未配置 Authenticode 签名。Windows 包由 Windows CI 构建并验证存储、权限与原生终端；GUI 展示在 macOS/Web 环境验证。
