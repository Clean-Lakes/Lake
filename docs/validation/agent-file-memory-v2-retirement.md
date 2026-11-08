# FM-01 第二批：V2 自动提取退役验收

2026-11-04，macOS arm64。PR #164 已按授权合入 develop `f59d377c6c71e2e61306ae1c218002a70c547ca9`：评审 head `9cfbf295`，集成树一致，原远端/本地分支已清理。本批从该提交开发。

实现 tested SHA：`e28c897610186f7390254d2ca7db4a08ae3c383a`；后续仅补充验证文档。范围见 [遗留审计第二批](../design/agent-file-memory-legacy-audit.md#第二批v2-自动提取退役)。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `go test ./...` | 通过；Web 重新执行 237.381s，其余包通过/复用有效缓存 |
| Web 定向 race（命令如下） | 通过，44.888s |
| `go vet ./...` | 通过 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过 |
| `corepack pnpm build:web`（web-agent 目录） | 通过 TypeScript 与 Vite；固定 pnpm 10.33.4，保留既有 chunk 大小提示 |
| `LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake.sh` | 通过；复用上行新页面产物，持久身份签名和 strict 验签成功 |
| 本地文档链接、diff check、V1/V2 SQL 常量与基线逐字对账 | 通过，冻结 DDL 未改 |

```sh
go test -race ./internal/web -run 'Test(Memory|ProjectMemory|Natural|Legacy|StrategyRetir|Navigation|SecurityMemory)' -count=1 -timeout=8m
```

新增回归验证：

- 旧 queued/retry/budget/running 任务停止调度，尝试次数、用量、来源 JSON/hash 和已完成任务不变；跨两次恢复和重启不重新领取。
- 未完且结果未知的 V2 派发超过 30 天后仍保留原行，不被重启结算/裁剪；原派发身份不改写为未执行或已核实。
- 旧手动重试与迟到 V2 输出被拒绝；相同 outbox 重送幂等，改内容重送冲突；当前 V1 来源仍能领取。
- 实际 HTTP/ADK 前台任务完成，处理旧 V2 队列不调用模型。该 fixture 关闭新 V1 提取以独立统计旧派发；当前 V1/自然记忆正向行为由原套件继续覆盖。
- 已撤回自然来源只留 hash，正文为空，coverage 仍为 withdrawn；退役回执不能使其重新落盘。
- AST 边界禁止已删除的 V2 提取、候选生成与模型派发依赖回到产品构建。

九项退役自动能力的正向测试随实现退出；历史候选观察时间测试改用旧格式 fixture，迁移/读取/忘记/资源范围测试保留。测试变化是退役验收要求，不把旧“成功提取”作为现状。

## 签名后端隔离 Dev 直接运行

使用 clean tested SHA 的签名二进制，执行：

```sh
python3 scripts/dev_build_origin.py write . bin/lake-dev-run-origin.json
python3 scripts/verify_memory_compatibility_dev.py --report /tmp/lake-fm01-v2-retirement-e28c8976.json
```

通过。二进制 SHA-256：`2cedd18edd75fa9d75fbe503e25fcb85bd8bbaaf0b27fa2c34fd13e296c21db2`。权限受限临时 Home、loopback 合成供应商；没有读写日常 Dev/正式 Home、真实凭据或桌面安装。

旧 v6 内容精确归档、不自动转换；旧开关保持关闭，旧策略 API 410，unknown 派发身份保留。跨后端重启完成两次普通 HTTP/ADK 任务：供应商请求 2，新实验记录 0、新纠错 0。Web 53 张与 ADK 2 张历史相关表重启前后 hash 相等。V2 自动提取的专项退役边界由上面的 Go/race 回归覆盖，此脚本本身不模拟完整 V2 Home。

## 缺口与回退

Windows 原生/WebView2/ACL、桌面窗口、真实模型质量及旧二进制往返未执行；不以签名后端运行代替原生界面验收。本批没有 UI 或数据库格式变化，不触发手动 CI，不打包或发布。

V2 手动管理/API/UI/历史存储仍待继续隔离退役，新文件记忆尚未启用，FM-01 协议未冻结。原 SQL/marker、拒绝不兼容 Home、历史撤回/遗忘和 Security 恢复继续保留。

回退经 develop PR，已写入的退役 blocked 不自动恢复排队，也不重置次数、用量或原操作账本。旧版本可能仍允许手动重试，不能将回退视为恢复旧派发的授权；无需 schema 回滚，不用旧库覆盖最新 Home。
