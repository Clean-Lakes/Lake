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

## UI 补验（2026-11-04）与剩余缺口

本次 UI tested SHA 为 `dca9786ea3cdacd005479f02eda51f6bdeb01c35`；与签名后端来源 `8d877ed1` 的 Go、脚本和前端树一致，差异仅为文档。本次未修改产品代码，未重新打包或替换桌面安装。

原生桌面验证使用已安装的 `~/Applications/Lake Dev.app`，通过 `--lake-home` 指向权限 0700 的独立临时 Home，并连接当前签名 `bin/lake` 提供的页面。未配置模型，未读取真实凭据，未使用日常 Dev 或正式 Home。使用合成项目“PR169 界面验收”及合成记忆：

- 从工作区设置进入“记忆”，通过“查看当前项目的事实与经验”打开真实 V1 管理页。
- 打开条目，编辑正文、保存并重新打开，确认 revision 增加且正文为“发布前检查备份，并记录验收结果。”。
- 浅色和深色下观察完整编辑器，正文、来源、保存按钮可见，输入框与弹窗圆角、边缘裁切正常；关闭后可再次从设置进入。
- 退出前恢复原浅色外观；本次原生实例和临时后端均已停止。

证据只含合成数据：[原生浅色编辑](pr169-native-v1-light.jpg)、[原生深色编辑](pr169-native-v1-dark.jpg)。Lake 是桌面应用，macOS 用 WKWebView 加载本机 Go 后端提供的 React 页面；仓库 `web-agent` 是这套界面的源码，浏览器辅助检查不代表另一个已交付的 Web 产品。

浏览器辅助 fixture：`web-agent/web/test/fixtures/project-memory.html`，直接挂载真实 ProjectMemory wrapper，API 为合成响应，不调用模型或主机。本次重新观察到浅色 V2 停用页只有说明及关闭按钮，关闭按钮初始获得焦点；正反 Tab 后焦点仍在关闭按钮，Escape 后对话框消失。已保存[停用页浅色截图](pr169-v2-light.jpg)，没有上传个人浏览器标签栏。

随后浏览器的元素点击和脚本检查反复在派发前超时，无法可靠完成重新打开、焦点返回和后续矩阵，不据此判定产品失败或验收通过。当前仍缺：

- V2 停用页的深色、390×844 页面视口及实际裁切。原生窗口最小尺寸为 850×600；390×844 是额外的响应式页面检查，不能称为原生窗口尺寸。
- 停用页完整关闭/重开/Escape/焦点返回循环。
- V1 列表中的历史 V2 任务停用说明与无重试按钮的视觉检查（对应代码与回归已有，视觉仍待补）。

本次未设置临时浏览器视口，新建测试标签页已关闭，Vite 服务已停止；先前任务遗留视口是否自动清理仍不能确认。复验入口可通过 `corepack pnpm exec vite --config web/vite.config.ts --host 127.0.0.1 --port 6191 --strictPort`（web-agent 目录）启动，使用 fixture 的 `version=1/2/3` 与 `theme=light/dark`。补齐剩余矩阵后再将草稿转正式 PR。

## 状态与回退

本批保持草稿 PR，不能将已完成的原生 V1 编辑验收扩大成完整 UI 矩阵通过。Windows 原生/WebView2/ACL、真实模型质量及旧二进制往返未执行；不触发手动 CI、不打包、不发布。冻结 SQL/版本和未知操作账本不改；V1 与历史读取/遗忘、Security 恢复及必要存储兼容保留。

回退经 develop PR 恢复入口代码，不需要回滚数据库；不能借回退恢复旧队列或重置用量。FM-01 仍需收敛 V2 存储兼容职责并冻结新文件协议，新文件记忆未启用。
