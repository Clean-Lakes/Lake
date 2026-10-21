# 策略学习 P1 本地验证记录

日期：2026-10-21；平台 macOS / darwin arm64；Go 1.26.6，Node 24.18.0，pnpm 10.33.4（corepack）。分支 `codex/strategy-learning-p1`，基线 `1dd1e5a6a425c569ab150ab597787b90c60043f1`。操作账号 bearqy。

## 验证范围及证据

| 检查 | 结果 |
| --- | --- |
| 修改前提示词/目录基线 | 17 组 golden，从上述 develop 基线生成；重构后逐字节 hash 一致，仅 GOOS 占位归一 |
| `go test ./...` | exit 0；ai 51.032s，web 134.960s；其余包通过或缓存 |
| `go test -race ./internal/ai ./internal/web ./internal/strategy` | ai 133.537s 通过；web/strategy 等待最终结果 |
| 新增用例竞态检查 `go test -race ./internal/ai -run '^TestStrategy\|^TestPrompt' -count=1` | exit 0；7.926s |
| `go vet ./...` | exit 0 |
| `python3 scripts/check_adk_runtime_boundary.py` | exit 0；原边界规则未放宽 |
| `corepack pnpm check` | exit 0 |
| `corepack pnpm test:frontend` | exit 0；337/337 通过 |
| `corepack pnpm build:web` | exit 0；Vite 提示已有的大 chunk 警告，未修改分包配置 |
| 格式/链接/diff | 最终提交前检查 |
| Lake Dev 签名构建及隔离 smoke | 待执行；执行结果将在提交 PR 前补齐 |

新增集成测试经官方 ADK 到本机合成 provider：实际请求前已经可读取清单，systemHash 对应发送内容；覆盖三个 profile、四个 SRE 角色、SRE 分流、workflow 和 stdio Handle 入口。检查动态记忆/todos/语言、输出超限的 retryOf、仅成功加载的 Skill 原文摘要及配对结果摘要、敏感配置排除、清单写入失败时零 provider 请求、重启并移除本地 JSON 缓存后的原生恢复及清空上下文后保留审计。

清单编码 golden 在 `internal/strategy/testdata/prompt-manifest.v1.json`。所有新增模型响应是本机测试数据；没有访问真实模型或生产资源，没有自动学习、候选试跑、收益评估或新增资源重试。

## 提交与开发环境

被测源码提交、最终 PR head 及 Dev 构建来源在本 PR 验证证据中记录；本文件随验证完成更新。开发环境使用签名构建脚本和隔离数据，不读取或复制正式版凭据，不重启正式 Lake。未进行 Windows 原生运行、真实 provider smoke 或视觉交互验收；本次无前端界面变化，不能把 macOS 编译/合成 provider 测试当作这些验收。

## 兼容及回退

没有业务数据库迁移；新增 JSON 字段和请求 artifact，旧会话缺布局时明确 compositionMatched=false。每次准备请求多一次 artifact 持久化与本地引用保存，失败则停止发请求。已有审批、工具权限、操作账本和恢复门禁不变；清单不是操作授权或已派发证明。回退通过独立 revert PR 到 develop，保留 artifact 和操作记录。

关联：[实现说明](../design/strategy-learning-prompt-manifest-v1.md)、[主计划](../../plan/feature-strategy-learning-1.md)。
