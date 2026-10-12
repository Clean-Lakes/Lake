# 原生 M 系列客户端发布验证

2026-10-12，版本 0.3.0，当前 Go/React 工作台的 AppKit/WKWebView 窗口。

- 已通过 `go test -race ./...`、`go vet ./...`、51 项前端测试和 React 类型检查/生产构建。
- Swift 更新策略覆盖 master、正式版本、版本比较、架构匹配、资产 URL、路径穿越及 SHA-256；四组通过。
- 独立安装器验证实际文件替换、旧应用备份、启动失败回滚、回执超时回滚和替换失败回滚；四项通过。
- 客户端与内置 CLI 的 Mach-O 架构均为 arm64，签名由持久 Lake 本地身份生成，`codesign --verify --deep --strict` 通过。
- 签名 CLI 在没有 Node 和其他可执行程序的 PATH 下通过嵌入 React、鉴权与 PTY 运行验证。
- 原生窗口实测透明融合标题栏；右上角更新按钮不依赖已有 Web 页面，点击能显示版本及 GitHub 检测结果。
- 用同一签名的隔离测试客户端（版本元数据 0.2.9）从线上 master Release 检测并下载 0.3.0。实际替换、重启成功，回执 0.3.0；更新后客户端与 CLI 字节匹配发布包，后端 PID 变化，隔离目录内测试项目保留。
- 更新退出先在正常事件循环中关闭后端，避免 AppKit terminateLater 阻塞 Swift actor 任务；同时保留自定义 home/data 路径。
- Release 的 target_commitish 为 master；四个资产分别是 arm64 DMG、ZIP 与两份 SHA-256，GitHub digest 与本地已签名产物一致。

当前使用本地签名证书，未 Apple Developer ID 公证。旧 Electron 客户端首次需手动安装。没有以生产凭据运行 AI 或远程操作；真实更新验证使用独立临时数据目录。
