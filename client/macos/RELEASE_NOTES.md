Lake v0.3.11：模型接入、MCP / Skills 与聊天输入改进。

- 新增主流模型厂商快速接入，可从 API 获取模型列表并搜索、多选添加。
- 统一模型与表单选择框，补充厂商品牌图标；优化 Magpie 接入后的模型显示、长列表滚动与模型切换。
- 新增 MCP 设置，支持 Streamable HTTP、SSE 和本机 stdio，可测试连接并查看工具。
- 新增 Skills 创建、编辑、目录导入和启停；聊天输入 `@` 可分类选择资源、Skills 与 MCP，并保留原有权限确认。
- 新增灰色行内文字建议，Tab 接受、Esc 忽略；中文输入法和 `@` 候选优先。
- 修复终端把普通命令末尾字符误替换为 `[REDACTED]` 的问题，完整凭据仍会脱敏。
- 修复 Windows 原生终端初始化和命令完成回执，保留 Bash 工作目录观测，并修正 Windows 安装包构建路径。

## 下载与安装

- macOS：Apple Silicon（M 系列）arm64，macOS 13+。提供 DMG、ZIP 和 SHA-256；将 Lake.app 安装到 Applications。
- Windows：Intel / AMD x86_64，Windows 10 1809+ / Windows 11。提供安装 EXE、免安装 ZIP 和 SHA-256，内置 Bash 与 SSH，无需 Node.js 或 WSL。安装版缺少 WebView2 时会验证 Microsoft 签名并安装官方运行环境，首次补装需要联网。

更新保留模型配置、会话、资源和凭据；重启会关闭当前终端连接，不自动重放历史命令。macOS 与 Windows 的旧正式版均可检测更高版本更新。

macOS 包使用持久 Lake Local Development Code Signing 证书签名，尚未使用 Apple Developer ID 公证。Windows 应用暂未配置 Authenticode 签名。Windows 包经交叉编译、结构和摘要检查，并由 Windows CI 验证存储、权限与终端；GUI 展示在 macOS/Web 环境验证。
