# 策略学习 P1 本地验证记录

日期：2026-10-21；平台 macOS / darwin arm64；Go 1.26.6，Node 24.18.0，pnpm 10.33.4（corepack）。分支 `codex/strategy-learning-p1`，基线 `1dd1e5a6a425c569ab150ab597787b90c60043f1`。操作账号 bearqy。

## 验证范围及证据

| 检查 | 结果 |
| --- | --- |
| 修改前提示词/目录基线 | 17 组 golden，从上述 develop 基线生成；重构后逐字节 hash 一致，仅 GOOS 占位归一 |
| `go test ./...` | exit 0；ai 51.032s，web 134.960s；其余包通过或缓存 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy` | exit 0；最终源码完整复跑 ai 114.010s / web 253.751s / strategy 1.351s |
| 新增用例竞态检查 `go test -race ./internal/ai -run '^TestStrategy\|^TestPrompt' -count=1` | exit 0；7.926s |
| `go vet ./...` | exit 0 |
| `python3 scripts/check_adk_runtime_boundary.py` | exit 0；原边界规则未放宽 |
| `corepack pnpm check` | exit 0 |
| `corepack pnpm test:frontend` | exit 0；337/337 通过 |
| `corepack pnpm build:web` | exit 0；Vite 提示已有的大 chunk 警告，未修改分包配置 |
| 格式/链接/diff | gofmt、diff 检查通过；4 份 Markdown 共 17 个相对链接存在、代码围栏闭合 |
| Lake Dev 签名构建及隔离 smoke | exit 0；`LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake_desktop.sh --dev --install`，签名与 deep/strict 验证通过 |

新增集成测试经官方 ADK 到本机合成 provider：实际请求前已经可读取清单，systemHash 对应发送内容；覆盖三个 profile、四个 SRE 角色、SRE 分流、workflow 和 stdio Handle 入口。检查动态记忆/todos/语言、输出超限的 retryOf、仅成功加载的 Skill 原文摘要及配对结果摘要、敏感配置排除、清单写入失败时零 provider 请求、重启并移除本地 JSON 缓存后的原生恢复及清空上下文后保留审计。

基线 golden SHA-256：

```text
920d3ae1936e4a6c47f4e9a6e37f9e40c652f848c7e5d6711c17dd519ea4bf10  internal/ai/testdata/strategy-disabled.v1.json
2784be0e63f9655636567936af66d355408805398729c5f27b1bad2dc1d0966a  internal/strategy/testdata/prompt-manifest.v1.json
```

清单编码 golden 在 `internal/strategy/testdata/prompt-manifest.v1.json`。所有新增模型响应是本机测试数据；没有访问真实模型或生产资源，没有自动学习、候选试跑、收益评估或新增资源重试。

## 提交与开发环境

被测源码及 Dev 构建提交为 `fbba9935179065a8885faf1c202d2ec3993871a3`，构建时工作区干净，Go 清单 buildCommit 与此提交一致、buildDirty=false。最终验证记录更新仅修改文档；最终 PR head 另记于 PR。

Dev 安装在 `~/Applications/Lake Dev.app`，后端 SHA-256 为 `8c5dcb08da77e5d985d8f6ac9bfc10633f61fab84c03a009e691c6237d92bf08`。签名二进制 `bin/lake ai --data <临时 Home>/web-agent/ai` 经真实 stdio configure/chat 向 127.0.0.1 合成 HTTP provider 发送一次请求：清单先于请求可读、systemHash 与实际系统输入一致、selectedAssets=[]、epoch=0；进程 exit 0，临时 Home 随验证删除。

尝试正常退出 Dev 以重开新包时，AppleScript 返回“用户已取消”（-128）；未强制退出、未继续重启。安装和签名验证通过，但**没有确认当前 Dev 窗口已加载新包**。开发环境使用签名构建脚本和隔离数据，不读取或复制正式版凭据，不重启正式 Lake。未进行 Windows 原生运行、真实 provider smoke 或视觉交互验收；本次无前端界面变化，不能把 macOS 编译/合成 provider 测试当作这些验收。

## 兼容及回退

没有业务数据库迁移；新增 JSON 字段和请求 artifact，旧会话缺布局时明确 compositionMatched=false。每次准备请求多一次 artifact 持久化与本地引用保存，失败则停止发请求。已有审批、工具权限、操作账本和恢复门禁不变；清单不是操作授权或已派发证明。回退通过独立 revert PR 到 develop，保留 artifact 和操作记录。

关联：[实现说明](../design/strategy-learning-prompt-manifest-v1.md)、[主计划](../../plan/feature-strategy-learning-1.md)。
