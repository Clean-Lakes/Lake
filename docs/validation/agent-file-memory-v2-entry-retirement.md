# FM-01 第三批：V2 手动入口与 UI 退出

2026-11-04，macOS arm64；基线 develop `caab241e89bc93f38e6395b69f3e85a285637296`。PR #167 评审 head `409d770c` 与集成树一致，已按授权合并并清理远端/本地分支。

Go/race tested SHA：`0be3a0316d0d3f50afe2a86bf4521e34cccc4080`。其后只保留当前自然偏好共用的空状态 CSS，并补充文档，没有 Go 变更；最终前端/签名后端在 `8d877ed13c4a8f25c7139ce7b7e2eaddb44e7495` 重建并通过复验；`git diff 0be3a031 8d877ed1 -- internal scripts` 为空，后续仅文档变动。范围见 [遗留审计第三批](../design/agent-file-memory-legacy-audit.md#第三批v2-手动入口与界面退出)。

## 本地检查

| 检查 | 结果 |
| --- | --- |
| `go test ./...` | 通过；AI 314.533s / Web 448.190s，全部包成功 |
| AI/Web 定向 race（命令如下） | 通过，Web 94.403s / AI 20.257s |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `corepack pnpm check`、`corepack pnpm test:frontend`（web-agent 目录） | 通过；586 项前端测试全部成功，无跳过 |
| `corepack pnpm build:web`（同目录） | 通过，既有 chunk 大小提示保留 |
| `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake.sh` | 通过；使用上行新产物，持久身份签名与 strict 验签成功 |
| V1/V2 SQL 常量逐字对账、本地文档链接、diff check、验收脚本编译 | 通过 |

```sh
go test -race ./internal/web ./internal/ai -run 'Test(Memory|ProjectMemory|Natural|Legacy|C3Production|C4Restored|Navigation|SecurityMemory)' -count=1 -timeout=8m
```

新增 Go 回归：V1 与历史 V2 fixture 均拒绝旧管理 URL 的全部方法；未认证 401、不存在项目 404；拒绝发生在正文解析前；V2 正向 HTTP/模型写入拒绝，正文/版本/来源/候选不被修改；DELETE 仍清理正文和派生记录。扩展 AI/Web AST 边界禁止旧入口重新进入产品。

三项旧 Go 管理正向验收、四项旧前端编辑/草稿验收随入口退出；新的格式门控测试验证 V1 可挂载、V2/未知/加载/错误不能挂载编辑器，停用态只有关闭按钮。既有访问摘要与当前自然记忆测试保留。

## 签名后端直接运行

最终二进制 SHA-256：`772c77933e01f3a7341445fc8f6bf6118f280474e5097958050ef7506b30e9c5`；来源记录为 clean `8d877ed13c4a8f25c7139ce7b7e2eaddb44e7495`。分别在独立、权限受限的临时 Home 运行：

```sh
python3 scripts/verify_memory_v2_entry_dev.py --report /tmp/lake-memory-v2-entry-8d877ed1.json
python3 scripts/verify_memory_compatibility_dev.py --report /tmp/lake-memory-entry-compat-8d877ed1.json
```

两项通过。第一项不配置模型：20 种旧入口/方法组合均 410，认证 401、缺失项目及跨项目正文 404，V1 保存/读取、重启对账、遗忘清正文正常；旧请求不修改当前数据。V2 旧表的写入拒绝与遗忘专项另由 Go 历史 fixture 回归覆盖，不在真实 Home 翻转 V2。

第二项使用 loopback 合成模型：跨后端重启的两次普通 HTTP/ADK 任务完成，供应商请求 2，新实验记录/纠错均 0，unknown 身份保留；Web 53 张和 ADK 2 张历史相关表 hash 一致。没有读取真实凭据、修改日常 Dev/正式 Home 或替换桌面安装。

## 最终 macOS 客户端补验（2026-11-04）

**剩余 macOS 界面项已补齐，可将 PR #169 转为正式 PR。** 最终客户端/夹具 tested SHA：`d1a57101457c479f7b062db01bfc8670738bad81`。React 类型检查、586 项前端测试（无跳过）及新构建在焦点修复提交 `d13e3a223784fbc53e4be10c034228ea2a6931ac` 通过；`d13e3a22..d1a57101` 只调整 `_test.go` 夹具的静态文件依赖，产品代码完全相同。

按用户要求，最终验收通过已安装的 `~/Applications/Lake Dev.app` 实际窗口完成，不以浏览器 fixture 作为客户端验收。没有重建/替换桌面安装，没有制作 ZIP/DMG。Lake 用 WKWebView 显示本机 Go 服务提供的 React 页面，仍是桌面应用。

### 隔离与测试后端

新增 `internal/web/project_memory_native_dev_test.go`，仅在显式给出新 receipt 文件时启动。它使用真实 `web.New`、真实路由和刚构建的 `assets/web/dist`，不替换 fetch、不增加模拟产品路由。Home 始终由 `t.TempDir()` 创建，不能传入日常 Dev/正式目录；不配置模型，日志不输出 runtime token。测试二进制经持久开发身份签名，SHA-256 为 `e303d9f00bee6a04e6392667aff4cc18b3456ed89c340ae2df2d07839c249a97`。

V1 场景含合成记忆及一项 blocked 历史任务；V2 场景沿已有 `memoryV2ForTest` 历史库夹具提供旧格式响应。这个参数只存在于测试代码，不增加 CLI/env 放量入口，生产 `operationalMemoryV2Ready` 仍为 false。不能把此夹具解释成当前生产二进制可以打开 V2 Home。

### 客户端验收矩阵

| 项目 | 实际操作与结果 | 证据 |
| --- | --- | --- |
| V1 编辑与持久化 | 从设置进入，改正文、保存、重开；revision 2 与完整正文一致，HTTP 复核一致 | [最终客户端编辑](pr169-native-v1-final.jpg) |
| 历史任务停用 | 展开真实任务列表，显示“旧版任务已停用”，没有重试按钮；任务仍为 blocked、attempts 3 | [浅色任务列表](pr169-native-jobs-light.jpg) |
| V1 深色窄窗 | 记忆条目、任务说明与关闭入口均可见，无横向裁切 | [深色窄窗任务列表](pr169-native-jobs-dark-narrow.jpg) |
| V2 正常窗口 | 浅/深色均只有停用说明与关闭按钮，无编辑/审核/采用/重试入口 | [浅色](pr169-native-v2-light.jpg)、[深色](pr169-native-v2-dark.jpg) |
| V2 原生窄窗口 | 手动缩到客户端最小尺寸附近；截图 852×602，文字、连续圆角、关闭按钮和键盘轮廓完整 | [浅色窄窗](pr169-native-v2-light-narrow.jpg)、[深色窄窗](pr169-native-v2-dark-narrow.jpg) |
| 初始焦点 | 打开后不按 Tab，直接回车可触发关闭 | [客户端按键记录](pr169-native-focus.json) |
| Tab / Shift+Tab | 正反 Tab 后仍可用回车触发唯一关闭按钮，不进入背后界面 | 同上 |
| Escape / 鼠标关闭 / 重开 | 关闭后按回车可以打开工作区菜单，证明恢复到仍存在的工作区入口；从设置可再次打开停用页 | 同上 |
| 点击外侧关闭 | 修复后关闭，再按回车可打开工作区菜单；焦点不再丢到页面 | 同上 |

V1 深色窄窗截图来自 `d0440216`，之后唯一产品差异是 V2 Gate 的外侧点击处理；V1 组件与样式没有变化。其余最终截图与客户端按键记录在 `d1a57101` 验证。长 V1 编辑器在容器内滚动，不把下面的来源和操作压到窗口外；实际保存、重开及正文/版本复核通过。

原生窄窗口遵守客户端 850×600 最小尺寸；之前的 390×844 浏览器页面尺寸不再作为客户端验收要求或通过依据。用户要求转客户端后已停止浏览器验收、恢复临时视口并关闭本次测试标签页。早先浏览器截图仅保留历史记录，不冒充原生证据。

### 本次发现与修复

客户端发现：点击遮罩外侧时，组件清理先恢复工作区焦点，随后浏览器默认 mousedown 行为又将焦点移到页面。`ProjectMemoryGate` 在命中遮罩自身时先 `preventDefault()` 再关闭，保留正常子元素点击。已在客户端复验外侧关闭 → 回车打开工作区；Escape、鼠标关闭、正反 Tab 与重开循环同时通过。回归采用实际客户端按键，不把静态 HTML 渲染测试当成交互证明。

### 复验入口

先构建新页面和签名后端，再单独编译测试夹具：

```sh
(cd web-agent && corepack pnpm build:web)
LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake.sh
go test -c -o /tmp/lake-memory-native.test ./internal/web
codesign --force --timestamp=none --sign 'Lake Local Development Code Signing' --identifier com.cleanlakes.lake.dev.memory-fixture /tmp/lake-memory-native.test
codesign --verify --strict /tmp/lake-memory-native.test
(cd internal/web && /tmp/lake-memory-native.test -test.run '^TestMemoryRetirementNativeDev$' -test.v -test.timeout=30m -memory-native-receipt=/tmp/lake-memory-native-v1.json)
```

保持夹具终端运行，在另一个终端读取权限 0600 的 receipt 中 `home`，以 `~/Applications/Lake Dev.app/Contents/MacOS/Lake --lake-home <该临时 home>` 启动客户端。V2 使用同一命令加 `-memory-native-v2`，并指定另一个尚不存在的 receipt；先退出前一个客户端，再 Ctrl+C 正常停止前一夹具。测试 Home 会自动清理。普通 `go test` 跳过这一人工 UI 夹具，不能将跳过算成界面通过。

### 最终后端复核与清理

焦点修复后的签名产品二进制来源 `d13e3a22`（clean），SHA-256 `659352fd0208ff2d0b5af217351bb09e5b143c7884425362243e3fecec972081`。再次执行入口与历史兼容两个隔离脚本均通过：[入口报告](pr169-entry-final.json)、[兼容报告](pr169-compat-final.json)。20 个退役请求组合、认证/项目隔离、V1 读写、重启/遗忘与历史 hash/unknown 保留仍正常。报告的 `nativeUIEvaluated:false` 如实表示它们是后端检查，原生界面证据由上方矩阵单独提供。

`go vet ./internal/web` 和 ADK 边界复核通过。未更改 Go 产品逻辑，不重复冒称完整 Go/race 已在新 SHA 运行；原完整 Go/race 证据仍见上文。V1/V2 客户端夹具均正常退出，临时后端通过 Ctrl+C 排空并释放 Home，恢复浅色和正常窗口，未保留模拟项目到日常数据。

## 状态与回退

本批 macOS 客户端补验通过，转正式 PR；本次不合并。Windows 原生/WebView2/ACL、真实模型质量及旧二进制往返未执行；不触发手动 CI、不打包、不发布。冻结 SQL/版本和未知操作账本不改；V1 与历史读取/遗忘、Security 恢复及必要存储兼容保留。

回退经 develop PR 恢复入口代码，不需要回滚数据库；不能借回退恢复旧队列或重置用量。FM-01 仍需收敛 V2 存储兼容职责并冻结新文件协议，新文件记忆未启用。
