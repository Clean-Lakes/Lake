# FM-01 首批遗留清理验收

2026-11-04，macOS arm64。范围见 [遗留审计](../design/agent-file-memory-legacy-audit.md)。

实现 tested SHA：`96e8d84ea4402a98c02c81c354f5c7efe158aa20`（develop 基线 `fe119f4f930e58ad7d95e7440b9170dd138f6c7a`）。后续提交仅修正文档和补充本文，不改变运行代码或测试。

## 本地检查

| 检查 | 结果 |
| --- | --- |
| `go test ./internal/ai -run 'Test(C3\|C4\|HistoricalStrategy\|StrategyRetired)' -count=1` | 通过；历史 JSON/hash 与篡改拒绝、投影恢复、退役边界和新请求不复活纠错 |
| `go test ./...` | 通过；AI 293.575s / Web 424.393s，全部包成功 |
| `go test -race ./internal/ai ./internal/web -run 'Test(C3\|C4\|Historical\|Legacy\|Natural\|Memory\|StrategyRetired)' -count=1 -timeout=8m` | 通过，AI 35.973s / Web 96.414s |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `corepack pnpm build:web`（在 `web-agent` 中） | 通过 TypeScript 与 Vite 构建；使用锁定 pnpm 10.33.4，保留现有大 chunk 提示 |
| `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake.sh` | 通过；使用上行新 Web 产物，持久身份签名与 strict 验签通过 |
| 本批 Markdown 本地链接、`git diff --check` | 通过 |

最初从根目录调用构建时，系统 pnpm 11.7.0 与项目 10.33.4 不匹配，构建停止。改为在 `web-agent` 使用固定版本构建，再走原签名脚本；未放宽版本检查或修改锁文件。

## 签名后端直接运行

`python3 scripts/dev_build_origin.py write . bin/lake-dev-run-origin.json` 后执行：

```sh
python3 scripts/verify_memory_compatibility_dev.py --report /tmp/lake-fm01-cleanup-dev-96e8d84e.json
```

通过。签名后端 SHA-256：`1672edbf0aec9ad73cfadd4d86a9f8c96a8f90c49c9de92549de57b775a91967`。来源记录为上述 clean tested SHA，使用脚本创建的权限受限临时 Home 与 loopback 合成供应商；没有读取日常 Dev/正式 Home 或真实凭据，未修改桌面安装。

- v6 准确归档、原开关关闭、不隐式转换为新自然偏好、原 unknown 派发身份保留。
- 旧 API 仍经现有边界返回 410，自然积累和使用同意仍独立关闭。
- 两次实际 HTTP/ADK 新任务跨后端重启完成；供应商请求合计 2，新实验清单 0，新纠错 0。
- 重启前后逐表 hash 相等，覆盖 Web 53 张历史相关表和 ADK 2 张表。历史 outbox 的缓存丢失/投影恢复另由 C4 回归覆盖。

此项属于签名后端的隔离 Dev 验证；不代表已安装桌面窗口验收，也没有替换正在使用的日常 Dev 后端。

## 缺口与回退

- Windows 原生/WebView2/ACL、桌面 UI 与真实模型质量未验证；本批没有界面或记忆内容算法变更。不触发 CI、不打包、不发布。
- 未提供旧二进制，本次不重复执行旧版拒绝新格式的回退往返；本批没有变更数据格式，原历史退出验收仍保留。
- FM-01 全量 caller 清单、V2 条件调用隔离及新文件协议尚待后续交付；当前有效 Memory 不关停。
- 代码回退经 develop PR 恢复删除实现即可，无数据库迁移需要回退；历史审计、正文和操作账本均未删除。
