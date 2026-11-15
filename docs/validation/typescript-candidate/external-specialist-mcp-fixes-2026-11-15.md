# 外部专员 MCP 网关 · 七项审查修复与 Dev 验证

日期：2026-11-15。代码及安装包 tested SHA：`e42f948287fd3b6f331d8e16f73761a00314f25b`。

## 修复与回归

| 问题 | 最终行为 | 回归证据 |
| --- | --- | --- |
| 并发幂等失效 | 消息、InputEvent、幂等回执在同一个 SQLite 事务中接纳，通知与调度在提交后发生。 | 8 个并发重试只接纳 1 条指令；内容冲突被拒；回执写入失败时消息与事件一起回滚，之后可正常重试。 |
| Pilot 回复串台 | 直接回复按实际结算的路由 batch/event 保存，并记录原 session/root；不再按时间选取其他轮次的消息。 | 旧请求在新指令到达后才结束时，新指令仍只取得自己的回复；后端重启、后来消息均不改变原回复。 |
| 已答复仍处于 routed | `respond` 的已结算回复返回 `replied`，`ask` 返回 `waiting_input` 和原问题。 | 两种路径均有独立 HTTP 回归。 |
| 长轮询读取旧事件 | 每次投影重读事件；最后一次休眠受剩余等待时间限制。 | 等待中的 stopped/blocked 更新可见；1 秒的服务端等待不固定休眠 2 秒。 |
| 命令遗漏自定义数据目录 | 设置 API 返回实际 data；原生二进制与脚本形式的复制命令均保留 `--data`。 | HTTP、前端命令回归，以及安装包在带空格的独立数据目录下完成真实 stdio 握手和调用。 |
| MCP 等待忽略总时限 | 先读取真实状态，再按剩余时间长轮询；请求头与正文读取都受预算约束，超时返回最后取得的状态。 | 1 秒等待、响应头到达后正文停滞的回归；安装包实测约 1003 ms 返回 running。 |
| 无效令牌测试随机失败 | 末位替换字符一定与原字符不同。 | 穷举十六种十六进制末位，含原末位为 0 的情况，验证原令牌有效而变更令牌被拒。 |

新增 9 项回归，并修正原有随机失败的认证测试。重点测试文件：`gateway.test.ts`、`gateway.test.cjs`、`mcp-stdio.test.ts`、`gatewaySettings.test.ts`。

## 自动检查

使用仓库固定 Node 24.14.0；完整结果摘要见 [results.json](external-specialist-mcp-fixes/results.json)。

| 检查 | 命令或入口 | 结果 |
| --- | --- | --- |
| TS 类型 | `tsc -p runtime/typescript/tsconfig.json` | 通过 |
| TS 全量 | `tsx --tsconfig runtime/typescript/tsconfig.json --test --test-concurrency=4 runtime/typescript/*.test.ts` | 319 项，315 通过、4 条件跳过、0 失败 |
| 后端 HTTP 全量 | `node --test --test-concurrency=4 runtime/typescript/*.test.cjs` | 270 项，264 通过、6 条件跳过、0 失败 |
| 前端全量 | `pnpm --dir web-agent test:frontend` | 824/824 |
| 网关重点用例 | 上述四个测试文件 | TS 10、HTTP 11、前端 4，全部通过 |
| Web 类型及构建 | `pnpm --dir web-agent build:web` | 通过；保留既有 chunk 提示 |
| 运行时构建 | `node runtime/typescript/build.mjs` | 通过 |
| 边界 | `python3 scripts/check_adk_runtime_boundary.py`、`python3 scripts/check_backend_naming.py` | 通过 |
| Dev 来源保护 | `python3 -m unittest discover -s scripts -p test_dev_build_origin.py` | 3/3 |
| Diff | `git diff --check` | 通过 |

## 签名安装与原生 Dev

在独立干净 worktree 的上述 SHA 执行 `scripts/build_lake_desktop.sh --dev --install`，持久 `Lake Local Development Code Signing` 身份签名通过。安装位置为 `~/Applications/Lake Dev.app`，bundle ID 为 `com.cleanlakes.lake.desktop.dev`。`build-origin.json` 的 `gitHead` 与 tested SHA 一致、`dirty: false`；后端 SHA-256：`a1db0f73fde5a6c17f7ae12af5f42fb30c7d38f63e9ab8ce3da4c0e125c1dda9`。应用及后端签名校验通过。

安装前通过原生菜单“停止内核并退出”结束旧 Dev。协议测试使用已安装的原生 Dev 应用、独立临时 `--lake-home` 和带空格的自定义 `--lake-data`；模型响应来自本机确定性 HTTP 夹具，未访问业务资源或外部模型。标准 MCP SDK Client 连接设置 API 提供的准确签名二进制命令，完成：

- stdio initialize / tools/list，单专员模式只返回 3 个工具。
- 8 个并发相同幂等键请求只生成 1 条指令和 1 项任务，实际报告通过 MCP 返回。
- 前一轮路由回复被延迟到新指令之后，仍能取得新指令的准确 Pilot 回复与 `replied`。
- 信息不足返回原问题和 `waiting_input`；1 秒等待约 1003 ms 返回真实 running 状态。
- 停止待路由指令时，已经开始的 HTTP 长轮询返回 `stopped`。

原生设置页已确认显示完整 `--data` 命令，见 [原生 Dev 截图](external-specialist-mcp-fixes/installed-dev-dark.jpg)。Ego Browser 在同一个安装包后端验证：

- [浅色 1110px](external-specialist-mcp-fixes/gateway-light-1110.png)、[深色 1110px](external-specialist-mcp-fixes/gateway-dark-1110.png)。
- [深色 390px 顶部](external-specialist-mcp-fixes/gateway-dark-390-top.png)、[深色 390px 命令与复制](external-specialist-mcp-fixes/gateway-dark-390-command.png)、[浅色 390px 命令与复制](external-specialist-mcp-fixes/gateway-light-390-command.png)：页面及面板均无横向溢出，命令换行，复制和删除可见，整个 Agent 页签可滚动。
- [键盘焦点与下拉](external-specialist-mcp-fixes/gateway-keyboard-light.png)：ArrowDown 打开 AppSelect，Escape 只关闭下拉并保留触发器焦点；已检查圆角、选中、悬停及裁切。

验证后关闭隔离 Dev 和 MCP/模型夹具、移除测试凭据所在的临时 Home，重新启动日常 `~/.lake-dev`，恢复原 HexHub 项目。原项目 136 项资源和 6 位专员保留；全目录 20 个项目、162 项资源、21 位专员可读。

## 兼容、边界与未验证项

没有修改资源许可、审批、Memory 同意或任务完成权威；`replied` 只表示实际回复已送达，不是业务成功证明。原操作、未知结果、旧任务和旧幂等回执不重放。未保存准确来源关联的历史纯 Pilot 回复不按时间猜测归属。回退修复提交可恢复原实现，新增的网关回复记录无需删除，也不作为授权来源。

未实测真实 Claude Code/Codex 应用接入，协议测试使用固定官方 MCP SDK Client；未运行 Windows/Linux，未用外部真实模型完成本轮验证。未触发 CI、合并 PR、发布或操作正式 Lake。
