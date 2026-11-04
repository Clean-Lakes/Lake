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

## UI 已观察与未完成矩阵

纯本地合成 fixture：`web-agent/web/test/fixtures/project-memory.html`，不调用模型或主机。实现冻结前已看到浅色停用页：只有说明和关闭按钮，初始焦点及 Tab 焦点均在关闭按钮。它不能代替最终 head 的完整 UI 验收。

浏览器自动化多次超时、连接断开，以下仍未完成：

- 深色与 390×844 窄窗口、实际角落和文字裁切；只设置视口或看到 URL 不算通过。
- 完整关闭/重开/Escape/焦点返回循环。
- V1 界面仍可编辑，旧 V2 任务只显示停用说明且没有重试按钮。
- 原生 Lake Dev 窗口验证；浏览器 fixture 不冒充原生验收。

曾设置临时视口；连接断开后 reset/close 被拒绝，独立测试标签页未能确认自动清理。该任务拥有的 Vite 服务已核对 cwd 后停止。未提交包含个人标签栏的整窗截图，也未上传截图；后续补验时仅保存测试页截图到本目录。

复验入口可通过 `corepack pnpm exec vite --config web/vite.config.ts --host 127.0.0.1 --port 6191 --strictPort`（web-agent 目录）启动，使用 fixture 的 `version=1/2/3` 与 `theme=light/dark`。补齐上述矩阵及截图后再将草稿转正式 PR。

## 状态与回退

本批保持草稿 PR。Windows 原生/WebView2/ACL、真实模型质量及旧二进制往返未执行；不触发手动 CI、不打包、不发布。冻结 SQL/版本和未知操作账本不改；V1 与历史读取/遗忘、Security 恢复及必要存储兼容保留。

回退经 develop PR 恢复入口代码，不需要回滚数据库；不能借回退恢复旧队列或重置用量。FM-01 仍需收敛 V2 存储兼容职责并冻结新文件协议，新文件记忆未启用。
