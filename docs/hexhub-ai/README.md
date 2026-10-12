# Lake Go AI 后端与增强终端

当前发布入口为 `bin/lake web --open`，Go 直接运行 HTTP、SQLite、AI Engine、PTY、SSH 与工具执行，内嵌 React 页面。运行和分发无需 Node 或 AI worker。`cmd/lake-ai` 保留独立 stdio 集成入口，旧 Node Web 后端仅存放在 `legacy/`，不参与发布。

macOS 用户二进制只通过 `scripts/build_lake.sh` 构建，由持久 `Lake Local Development Code Signing` 身份签名；缺少身份先运行 `scripts/setup_lake_signing.sh`。模型及 SSH 凭据使用 Lake 私有文件，正常操作不访问 Keychain。完整运行方式见 [工作台说明](../../web-agent/README.md)。

## 增强终端功能

- 本地终端创建时可选择 sh、Bash、Zsh 或 Fish；SSH 资源保存 shell 选项，默认 sh。不支持的配置或未安装的 shell 明确报错，不切换其他目标。受控交互 shell 使用自有 hooks，不修改用户配置文件。
- Bash/Zsh/Fish 的 OSC hooks 记录当前目录、人工/Agent 输入命令块及退出状态；sh 使用命令完成标记。hooks 是状态观测，不构成授权。
- 按实际终端能力生成 `terminal2` 工具集；hooks 不可用时撤下命令块执行，保留可用的读屏和交互能力。断线仅可读取明确标记的历史输出，expect 不会用旧输出成功匹配。
- 终端侧 AI 按 `enhanced-terminal`、项目、资源类型和资源 ID 恢复历史。同资源多终端需要明确绑定；绑定另一终端前处理或停止当前轮次。重建后提示新 shell 不继承旧目录与环境。
- 当前终端上下文包含精确终端 ID、generation、cwd、最近 24 个命令块，每块输出尾部最多 12000 个 Unicode 字符，会话文本总尾部最多 16000 字符。服务端上下文和用户消息独立限制，超出模型预算的旧证据会标记裁剪；工具历史继续参与现有压缩。
- 停止 AI 本轮取消推理、审批与等待，已启动的命令继续运行并保留状态。Ctrl-C 请求中断前台命令，无法确认的结果保持未知；关闭终端才结束 PTY。后台完成更新原卡片，不改变新轮次状态。
- 同项目其他聊天的终端需要精确 ID/generation 的采用授权。终端和命令记录保留原 owner，执行审计记录请求会话。写入需用户明确交接，并由单一 Agent 会话持有；人工接管、关闭、权限变化和服务重启使原授权失效。
- 会话持久记住明确引用及批准过的资源，可在会话设置查看和清除。资源删除不留下有效访问权限；新增资源不自动获得授权。

## 已保留的 AI 能力

模型支持 OpenAI Chat Completions、Azure OpenAI、Responses、Anthropic Messages、Gemini 与 Ollama。场景为 `core`、`terminal2` 和 `db-query-editor`。保留流式正文与推理、图表、图片、操作/审批、文件变更预览及恢复、后台任务、SQL/Redis/Docker/SSH 隧道/SCP、预设、回退和上下文压缩。

数据库驱动支持 PostgreSQL、MySQL 和 SQLite；其他驱动不在当前范围。凭据只通过私有文件引用提供，不返回模型密钥或 SSH 私钥。SSH 主机身份使用严格信任校验及现有用户确认流程。

用量百分比来自最新 provider 输入用量和已知模型容量；未知仍显示未知。压缩预算和保守上下文估算不宣称为精确 tokenizer。

## 与 HexHub 的对应范围

[逆向分析报告](HexHub_AI增强终端逆向分析报告.docx) 与 [R01–R34 发布代码证据](rea-current/source-evidence.md) 是行为对照依据。没有恢复 HexHub 原始 Go/Vue/TypeScript 源码；本实现是 Lake 的功能重建。

保留 Lake 当前静默命令、文件写入和灾难性操作确认规则；采用授权独立于命令静默。当前审批仍阻止同一 AI 会话开启新轮次。HTTP/SSE 与 HexHub WebSocket 的传输差异不属于功能缺失。报告未证明 HexHub abort 一定保留 shell，也未证明其每轮固定采集主机快照。

## 开发和验收

```sh
go test ./...
go test -race ./internal/web ./internal/ai
pnpm --dir web-agent check
pnpm --dir web-agent test:frontend
scripts/build_lake.sh
```

测试使用本地模型夹具、真实 PTY 和临时 sshd/合成凭据。发布验收使用签名二进制、独立 Lake home，保持用户当前服务不受影响；测试通过不等于所有商业网关均兼容。

[补齐计划](../../plan/feature-hexhub-terminal-parity-1.md) · [本次验收](../validation/lake-hexhub-terminal-parity.md) · [原始恢复契约](recovered-contracts.ts)

本轮逐项复核补齐终端面板图片/上下文引用、实时采样时间及授权永久撤销，并拒绝终端与资源不匹配配置。[24 步验收清单](../../docs/validation/lake-terminal-plan-step-audit.md)
