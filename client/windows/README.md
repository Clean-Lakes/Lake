# Lake for Windows x86_64

点击 × 收起到后台，保留当前会话、终端连接和任务。点击系统托盘中的 Lake 图标或右键选择“显示工作台”恢复；再次运行同一数据目录的客户端也会唤回原窗口，不启动第二个后端。托盘菜单的“退出 Lake”才执行正常退出。系统托盘不可用时回退为最小化，保留任务栏入口，并可通过 Alt+Space 系统菜单中的“退出 Lake”结束程序；注销和关机继续正常退出。此行为不阻止系统休眠。

支持 Windows 10 1809+、Windows 11，Intel / AMD 64 位处理器。使用当前 Go + React 工作台和原生 WebView2 窗口，随软件包携带 Bash、SSH 及常用工具；无需安装 Node.js、Python、Git 或 WSL。

安装版运行 `Lake-<version>-windows-x86_64-setup.exe`；安装向导提供目录选择页，默认按用户安装到 `%LOCALAPPDATA%\Programs\Lake`，也可浏览或输入自定义目录，并显示所需空间与剩余空间。再次安装和自动更新会沿用上次安装位置；静默安装仍支持 NSIS `/D=完整路径`（放在命令行末尾）。安装后创建桌面与开始菜单快捷方式。若 WebView2 Runtime 缺失，安装程序验证 Microsoft 签名后安装随包的官方引导程序；首次补装运行环境需要联网。

免安装版解压整个 ZIP 后运行 `Lake.exe`，不要单独复制 EXE。WebView2 Runtime 必须已经安装；也可运行 `resources\WebView2Setup.exe`。用户数据存放于 `%USERPROFILE%\.lake`，卸载保留数据。

客户端使用自身内置后台，关闭窗口会正常停止调查并落盘。若已有 CLI 后台占用同一数据目录，请先关闭该后台；不会悄悄复用旧后台而显示旧界面。Windows 终端使用随包 Bash 和 ConPTY，SSH 连接遵循原有主机指纹确认和命令审批规则。Windows 本机指标与 Linux/macOS 的命令存在差异；可在 Bash 中使用系统 PowerShell 命令。

构建：`python3 scripts/build_lake_windows.py`，需要 Go、pnpm、Python 3、7-Zip 和 NSIS。macOS 主机构建当前 CLI 时仍调用签名 `scripts/build_lake.sh`；Windows 后端使用纯 Go SQLite，所有分发的客户端/CLI EXE 为 amd64。NSIS 安装器引导程序为 x86，安装和运行的是 x86_64 应用。

输出位于 `dist/windows/<version>/x86_64/`，包含 ZIP、安装 EXE 和 SHA-256。当前 Windows 分发未配置 Authenticode 应用签名；本地交叉编译不等于 Windows GUI 运行验收，Windows CI 定义提供存储、权限、终端和安装包验证。

日常联调使用 `python3 scripts/build_lake_windows.py --dev`，产物在上述目录的 `dev/` 下，文件名以 `Lake-Dev-` 开头。Dev 窗口显示 `DEV`，任务栏标题包含 `Lake Dev <version>`；安装器使用独立的 `%LOCALAPPDATA%\Programs\Lake Dev`、`Lake Dev` 快捷方式和卸载项。数据固定保存到 `%USERPROFILE%\.lake-dev`，更新、移动程序或重新安装均沿用该目录，卸载也保留数据。Dev 忽略正式版的 `LAKE_HOME`；需要专用测试目录时只设置 `LAKE_DEV_HOME`，不能指向 `.lake` 或其子目录。Dev 不接收正式版自动更新。自动化测试的临时隔离目录不用于日常 Dev 启动。

桌面进程内嵌 Go 后台；SSH 密码和密钥口令助手使用同包的 `resources/lake.exe` 控制台程序，通过 OpenSSH 私有管道返回凭据。不得依赖 GUI 子系统的 `Lake.exe` 继承标准输出句柄。Windows CI 在打包后解压实际 ZIP，检查助手的 PE 子系统，并使用包内 SSH 在含中文、空格的路径下验证交互式密码认证。

密码登录依次支持 SSH password 和 keyboard-interactive 的普通密码提示，以兼容 PAM 服务器。保存的密码不用于验证码、一次性密码、修改密码或主机信任确认；密钥登录不回退到密码。CI 同时验证 PAM-only 服务器和 OTP 提示的拒绝行为。

启动 ConPTY 前按 Windows 大小写规则合并重复环境变量，以本次连接设置覆盖继承的 SSH 凭据助手和凭据引用。连接错误会显示实际尝试的账号、地址和端口；不输出密码或原始 SSH 日志。包内连接测试同时覆盖继承旧助手和修改账号、密码后重新连接。

Windows SSH 将诊断写入私有凭据目录下的临时文件，以免 ConPTY 提前退出时丢失原因。进程退出后仅读取有界尾部并转换为固定错误分类，删除临时文件；会话历史仅保留固定原因以维持重启后的重试暂停。凭据助手失败只输出固定提示，不输出凭据值。

PR 或非 master 分支的 Windows CI 构建仅作为测试产物保留 14 天，名称为 `Lake-windows-x86_64-test-<run-id>`，附带 `TEST-BUILD.txt` 和来源提交记录，不创建正式 Release，不修改稳定更新渠道。测试包内版本号沿用源码 `VERSION`，不能仅靠版本号区分构建；请同时核对来源提交。优先将完整 ZIP 解压到独立目录，在 PowerShell 中设置 `$env:LAKE_HOME = "$env:LOCALAPPDATA\LakeTest\<build-id>"` 后从该目录启动 `Lake.exe`，避免使用正式数据。安装 EXE 仍是普通用户级安装器，会覆盖已有安装。

Lake 工作台顶栏与窗口标题栏合为一体，右上角提供最小化、最大化或还原、关闭按钮。在顶部品牌、项目路径或终端标题的空白处拖动窗口，双击可最大化或还原；窗口仍保留 Windows 缩放边框。高对比度模式下窗口按钮使用系统颜色。

窗口与托盘显式加载内嵌的 Lake 品牌图标，包含 16、20、24、32、40、48、64、128、256px 图像；独立本地构建也使用相同图标，Explorer 重启后继续恢复该托盘图标。打包脚本使用同一份 `icon.ico` 生成 EXE 图标资源。

启动时在 WebView 创建窗口、首次显示前暂时隐藏 DWM 合成窗口，完成标题栏合并并挂载工作台后再显示，避免原生标题栏和空白窗口闪现。创建钩子仅作用于当前 UI 线程的工作台窗口，创建后立即移除；连接失败或需要登录时会显示对应页面。界面始终未能加载时，30 秒后退出并提示重启。

最大化按当前显示器的工作区计算，保留任务栏，包含任务栏位于顶部或两侧及多显示器的情况；再次双击恢复窗口，不进入全屏模式。

顶栏右侧“检查更新”检测 GitHub master 的 Windows 正式版本；启动后 3 秒及每 5 分钟自动检查。发现更高版本后可下载安装，先匹配官方 GitHub 资产摘要和 SHA256 文件，再等待客户端完全退出后执行用户级安装器并重新打开。安装保留 `%USERPROFILE%\.lake`，但会关闭终端连接；免安装用户更新后使用标准用户目录中的安装版。此前不带更新入口的 0.3.3 软件包需要先手动安装新包，之后才能在客户端更新。安装成功后自动删除下载的安装包，重新打开的客户端重试清理完成任务目录及暂时锁定的安装助手；未完成、失败或包含未知文件的任务不被清理。相同版本的资产替换不会触发版本升级。

第三方：PortableGit 固定版本和摘要位于 `runtime-lock.json`，软件包保留其许可证，原始源码可由其中的 sourceArchive 链接取得；Go WebView2、ConPTY 和 SQLite 的许可证随 resources/licenses 分发。Microsoft WebView2 Runtime 按 Microsoft 自身许可安装。
