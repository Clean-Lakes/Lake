# Lake for Windows x86_64

支持 Windows 10 1809+、Windows 11，Intel / AMD 64 位处理器。使用当前 Go + React 工作台和原生 WebView2 窗口，随软件包携带 Bash、SSH 及常用工具；无需安装 Node.js、Python、Git 或 WSL。

安装版运行 `Lake-<version>-windows-x86_64-setup.exe`；按用户安装到 `%LOCALAPPDATA%\Programs\Lake`，创建桌面与开始菜单快捷方式。若 WebView2 Runtime 缺失，安装程序验证 Microsoft 签名后安装随包的官方引导程序；首次补装运行环境需要联网。

免安装版解压整个 ZIP 后运行 `Lake.exe`，不要单独复制 EXE。WebView2 Runtime 必须已经安装；也可运行 `resources\WebView2Setup.exe`。用户数据存放于 `%USERPROFILE%\.lake`，卸载保留数据。

客户端使用自身内置后台，关闭窗口会正常停止调查并落盘。若已有 CLI 后台占用同一数据目录，请先关闭该后台；不会悄悄复用旧后台而显示旧界面。Windows 终端使用随包 Bash 和 ConPTY，SSH 连接遵循原有主机指纹确认和命令审批规则。Windows 本机指标与 Linux/macOS 的命令存在差异；可在 Bash 中使用系统 PowerShell 命令。

构建：`python3 scripts/build_lake_windows.py`，需要 Go、pnpm、Python 3、7-Zip 和 NSIS。macOS 主机构建当前 CLI 时仍调用签名 `scripts/build_lake.sh`；Windows 后端使用纯 Go SQLite，所有分发的客户端/CLI EXE 为 amd64。NSIS 安装器引导程序为 x86，安装和运行的是 x86_64 应用。

输出位于 `dist/windows/<version>/x86_64/`，包含 ZIP、安装 EXE 和 SHA-256。当前 Windows 分发未配置 Authenticode 应用签名；本地交叉编译不等于 Windows GUI 运行验收，Windows CI 定义提供存储、权限、终端和安装包验证。

桌面进程内嵌 Go 后台；SSH 密码和密钥口令助手使用同包的 `resources/lake.exe` 控制台程序，通过 OpenSSH 私有管道返回凭据。不得依赖 GUI 子系统的 `Lake.exe` 继承标准输出句柄。Windows CI 在打包后解压实际 ZIP，检查助手的 PE 子系统，并使用包内 SSH 在含中文、空格的路径下验证交互式密码认证。

PR 或非 master 分支的 Windows CI 构建仅作为测试产物保留 14 天，名称为 `Lake-windows-x86_64-test-<run-id>`，附带 `TEST-BUILD.txt` 和来源提交记录，不创建正式 Release，不修改稳定更新渠道。测试包内版本号沿用源码 `VERSION`，不能仅靠版本号区分构建；请同时核对来源提交。优先将完整 ZIP 解压到独立目录，在 PowerShell 中设置 `$env:LAKE_HOME = "$env:LOCALAPPDATA\LakeTest\<build-id>"` 后从该目录启动 `Lake.exe`，避免使用正式数据。安装 EXE 仍是普通用户级安装器，会覆盖已有安装。

Lake 工作台顶栏与窗口标题栏合为一体，右上角提供最小化、最大化或还原、关闭按钮。在顶部品牌、项目路径或终端标题的空白处拖动窗口，双击可最大化或还原；窗口仍保留 Windows 缩放边框。高对比度模式下窗口按钮使用系统颜色。

顶栏右侧“检查更新”检测 GitHub master 的 Windows 正式版本；启动后 3 秒及每 5 分钟自动检查。发现更高版本后可下载安装，先匹配官方 GitHub 资产摘要和 SHA256 文件，再等待客户端完全退出后执行用户级安装器并重新打开。安装保留 `%USERPROFILE%\.lake`，但会关闭终端连接；免安装用户更新后使用标准用户目录中的安装版。此前不带更新入口的 0.3.3 软件包需要先手动安装新包，之后才能在客户端更新。安装成功后自动删除下载的安装包，重新打开的客户端重试清理完成任务目录及暂时锁定的安装助手；未完成、失败或包含未知文件的任务不被清理。相同版本的资产替换不会触发版本升级。

第三方：PortableGit 固定版本和摘要位于 `runtime-lock.json`，软件包保留其许可证，原始源码可由其中的 sourceArchive 链接取得；Go WebView2、ConPTY 和 SQLite 的许可证随 resources/licenses 分发。Microsoft WebView2 Runtime 按 Microsoft 自身许可安装。
