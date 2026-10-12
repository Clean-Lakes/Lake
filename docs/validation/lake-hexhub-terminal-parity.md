# Lake 增强终端补齐验收

2026 年 10 月 11 日，已在 `claude/lake-web-agent-v1` 工作区完成六阶段补齐，并通过 `scripts/build_lake.sh` 生成签名 `bin/lake`。工作区原有未提交改动保留；未切换用户当前 4177 服务。

## 功能结果

| 对照项 | 实现与验收 |
| --- | --- |
| 终端内 AI 与资源 scope | 终端工具栏提供独立 AI 面板；项目/资源 scope 并发创建去重，刷新和重启保留聊天；同资源换终端需明确重新绑定。 |
| 四种 shell 与 hooks | sh/Bash/Zsh/Fish 真实本地 PTY 测试通过，包含 cwd/env、重复命令与原始 Agent 输入；命令完成前发布 cwd，防止下一轮读取旧目录。Fish 测试环境通过 Homebrew 准备；受控 shell 禁用外部命令历史写入，命令审计保存在 Lake。 |
| 上下文与长消息 | 精确终端的最近 24 个命令块，每块 12000 字符，包含运行中/未知结果；cwd、generation 和会话文本进入模型。100000 个中文字符的 HTTP 消息仍带服务端上下文进入真实模型请求夹具；超限拒绝。 |
| 跨 owner 采用 | 同项目精确 ID/generation 授权，读取与独占写入分开；原 owner/请求者审计保留；跨项目、未授权、权限变化、人工接管、关闭及重启后的访问拒绝。后台操作与等待命令归属也经过校验。 |
| 引用记忆 | 明确引用和批准资源持久保存，重新配置时过滤失效资源，支持单独清除；历史文本不产生访问授权。 |
| 工具能力降级 | 每次模型请求刷新终端能力；不可用的执行/input/expect 不暴露；模型强行调用不进入终端执行桥。 |
| 停止、中断、关闭 | 停止本轮/等待超时保留命令及 PTY；Ctrl-C 与关闭分别处理；用户显式关闭仍可终止被采用的终端并撤销授权。后台完成更新原卡片。 |
| 历史读屏 | 来源、采集时间、generation、status 明确返回；断线旧输出不能成功满足 contains/regex expect，重复历史读取不伪造采集时间。 |

## 检查结果

- `go test ./...` 通过。
- `go test -race ./internal/web ./internal/ai` 全套通过；后续新增或修正的 shell、cwd、Unicode、命令归属、采用授权与显式关闭路径均经过针对性竞态测试，cwd/shell 边界用例重复两次通过。
- `pnpm --dir web-agent check` 通过，`pnpm --dir web-agent test:frontend` 的 35 项测试通过。
- `scripts/build_lake.sh` 完成前端构建、Go 构建及签名；最终 Go 更新使用同一脚本的 `LAKE_REUSE_WEB_ASSETS=1` 路径构建。
- `codesign --verify --strict bin/lake` 通过，Authority 为 `Lake Local Development Code Signing`，Identifier 为 `com.cleanlakes.lake`。
- 独立 home 下，签名二进制在无 Node 的 PATH 启动；本地模型夹具验证未批准的终端访问拒绝、采用/交接、运行中停止、generation 保持、cwd 注入、回复和 scope 恢复；用户明确采用的资源进入访问记忆。
- 重启后创建新 generation，scope 历史保留、要求重新采用，并返回 shell 重建提示。浏览器验证终端 AI 面板、当前目录、旧回复恢复及同一物理终端去重；控制台无错误。

结构化结果和最终二进制 SHA256 见 [验收数据](lake-hexhub-terminal-parity.json)。

## 界面证据

[终端 AI 当前目录与历史](lake-hexhub-terminal-parity.png) · [恢复的 AI 回复](lake-hexhub-terminal-history.png)

## 验收范围

模型端到端使用本机 HTTP/SSE 夹具；SSH 使用测试套件的临时 sshd 与合成凭据。未使用用户商业模型密钥或生产 SSH 资产。Windows PTY 不在本次范围。前端构建仍提示现有的大包体积建议，构建成功。

本次使用独立测试数据与端口，测试服务和自建临时资源在验收后清理。保留 Lake 当前静默命令、灾难性操作确认与文件权限行为；报告中未确认的 HexHub 原生停止行为不宣称一比一复刻。
