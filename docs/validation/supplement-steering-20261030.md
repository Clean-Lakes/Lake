# 运行中补充即时显示与推理抢先接入

- 基线：`origin/develop` `f70eed4831e0bfa4d9c119c7b3113ba522e957aa`。
- 功能代码：`422f35e6`（主实现 `62633324`）。
- Lake Dev 本地集成代码：`5e4d282dee7d755a05477bf1c0ec03fe3d362056`，额外保留已安装的 #128 最新执行检查栏；集成分支不推送、不代替 PR 合并。
- macOS arm64 / Lake Dev 0.3.22 / `~/.lake-dev`。不操作正式版。

## 行为

服务端接收补充后立即把它显示在当前对话末尾，使用静态“补充已发送 · 等待接入”，从队列隐藏该项。实际接入后由同一 ID 的正式用户消息替换，未接入就停止/失败则仍从原队列恢复；排序剩余草稿时保留所有服务端队列 ID。

用户明确选择“尽快接入，允许中止并继续推理”。本次仅取消正在进行的 provider 请求，不取消 ADK 根 invocation 或工具上下文。ADK 的公开 OnModelError / AfterModel 回调派发原有可信 supplement 控制工具，带真实用户输入继续同一 RootTurnID；不增加另一套模型/工具循环，不重置额度，不重复已执行操作。被替代的部分回复保留为 interrupted draft，不能成为已完成回答。正在执行的工具和上下文压缩仍在原安全边界返回后接入。

## 验证

- `go test ./...`：通过（web 包约 271 秒）。
- `go vet ./...`：通过。
- 定向 `go test -race ./internal/ai ./internal/web -run 'TestUserSupplement|TestMessageQueue.*Supplement' -count=10`：通过。
- 完整 `go test -race ./internal/ai ./internal/web ./internal/agent/...`：通过（ai 约 193 秒，web 约 550 秒）。
- `python3 scripts/check_adk_runtime_boundary.py`：通过。
- 功能分支前端：553 项通过；保留 #128 的 Dev 集成前端：556 项通过。
- `scripts/build_lake_desktop.sh --dev --install`：类型检查、Vite、Go/Swift 构建和签名安装通过，保留已有 chunk / Swift 构建系统警告。
- `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app`：通过，build-origin 为上述 clean 集成提交。
- 真实 App + 虚构浏览器数据：推送立即显示在对话且无持续 spinner；其他草稿仍可排序；未接入恢复原队列；回执后只保留一条正式消息。已检查深色及 760px 窄窗截图。
- 新的 HTTP SSE 测试保持首个模型响应不结束，收到补充后要求 3 秒内观察到请求取消；后续请求必须包含补充、不含旧半截回复；完成后 RootTurnID 和 Turns 保持原值、历史协议合法。实际运行中工具保持原上下文，旧后续写入被阻止；失败入队不取消模型。

## 当前 Dev 验证边界

签名安装后原生窗口控制接口暂时持续超时，因此由用户正常退出并重开 Dev。已验证新后端 PID 22379 提供本次 JS `index-D196aszw.js` 和 CSS，与构建 dist 字节完全一致；安装后端 SHA256 与 clean build-origin 一致，来源为 `5e4d282d`。重开后的原生 WK 窗口正常渲染，URL 对应新后端。没有为验收发送真实模型消息或执行实际资源操作。

## 风险与回退

取消 HTTP 请求不保证上游停止计费；已产生的用量沿原账本记录，不编造未返回用量。不改凭据、执行权限、工具能力或数据库格式。仅被实际接收的真人补充可触发抢先接入；实际失败和父上下文取消不被回调吞掉。通过后续 revert PR 可回退。
