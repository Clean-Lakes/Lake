# CM 首批：Pilot 工作集与基础角色知识契约验收

2026-11-05，macOS arm64，Go 1.26.6、Node 24.14.0、Lake Dev 0.3.27。实现范围见[契约](../design/context-role-memory-contract.md)，不将本批称为完整长期记忆交付。

## 来源与范围

- 运行代码提交：`e7b18f0622ed998c7dfa06d71ab660bdd873a9fc`；从 `origin/develop caab241e` 开始，复用 PR #176 的历史目录恢复修复。
- 验收脚本最终提交：`cb7d3ca054a745cd0e5771eb621ec13b4be4d768`。其后本记录仅补证据。
- 签名构建并安装的干净 Dev 集成提交：`fc0d84c6682923f962cb8e15fdcc9cb79b3f0822`，包含上述运行代码及此前已装 Dev 候选。后续脚本修正不改变后端/前端运行代码；私有集成分支不推送。
- 后端 SHA-256：`889215c0f4c440ec309204caa20b6251d69cc02abe77312ea308f3069e098523`，与安装包 build-origin 一致；持久开发签名验证通过。
- 目标 PR 为 `develop`，未执行合并或生产发布；没有触发手动 CI。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| `go test ./... -count=1 -timeout=15m` | 通过；功能分支固定期间全量重跑，AI 141s、Web 321s。 |
| `go test -race ./internal/ai ./internal/memory -run 'TestTaskDigest\|TestPilotWorkingSet\|TestPilotActual\|TestContext\|TestRoleScope\|TestRouterContextContains\|TestRouterHistoryProjection\|Test.*Compaction\|TestIdle\|TestSuperTaskReference' -count=1 -timeout=10m` | 通过；AI 165s。 |
| `go vet ./internal/ai ./internal/memory ./internal/web` | 通过。 |
| `python3 scripts/check_adk_runtime_boundary.py` | 通过。 |
| `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend` | 功能分支类型检查及 589/589 测试通过；Dev 集成类型检查及 601/601 测试通过。 |
| `python3 -m py_compile scripts/verify_superagent_dev.py` | 通过；最终脚本再执行完整签名原生 fixture 成功。 |

百任务回归使用 100 个原任务及独立 Worker/Session，每项各保留 256 KiB 合成档案，Pilot 另有历史准确读取结果。真正关闭引擎并从持久 ADK 恢复后，模拟闲置恢复、新用户要求及本轮准确工具续接；捕获的两次实际 provider 消息 JSON 约 22.9/24.1 KB，不包含原大输出，也没有额外摘要模型调用。当前“不得重启”约束、本轮工具结果及全部独立任务档案仍在。

其他新增回归覆盖：冻结职责版本、不同任务身份、原始要求/hash、失效 revision、错误 hash 不推进读取游标、摘要 UTF-8/JSON 转义总长、伪完成不能变成验收通过、跨任务摘要拒绝、默认 8 条优先摘要及分页标志、未消费事件/无来源消息/未知用户补充不省略、普通会话不参与投影、占用不将保留档案误算为请求。

早期夹具曾超过单档案 24 MiB 上限，并在未关闭旧引擎时打开同一测试库；现已改为独立任务档案及真正冷关闭恢复。一次全量运行期间切换 Dev 分支导致运行时读取的提示词 golden 与已编译源码不一致；最终固定功能分支全量重跑通过。原生 fixture 补齐 rich-content 解析、调用 ID 和失败时内核清理后，以干净最终脚本重新执行通过；未修改 golden 或放宽断言来通过检查。

## 签名 Lake Dev 与实际请求

使用 `scripts/build_lake_desktop.sh --dev --install`，原生 UI 通过“停止内核并退出”关闭旧 Dev 后安装。完整隔离验证命令：

```sh
python3 scripts/verify_superagent_dev.py \
  --binary "$HOME/Applications/Lake Dev.app/Contents/Resources/lake" \
  --native "$HOME/Applications/Lake Dev.app/Contents/MacOS/Lake" \
  --output /tmp/lake-cm-signed-dev-final.json \
  --manage-specialists --inherit-project-access --verify-context-working-set
```

fixture 使用临时 Home、回环假 provider 和两个真实只读文件，不复制日常/生产凭据。结果见[结构化记录](lake-context-role-memory-dev.json)：

- 空闲专员创建/编辑不建任务；改名及职责 revision=2 在冷重启后保留，同一 RoleID 复用于两个不同 Task/Worker/Session。
- 沿原项目目录和权限，未 PUT 新 policy；两次实际文件读取，各原目标验收通过并持久投递 Pilot 报告，未出现人工问题。
- 完成后再检查已有任务：实际 provider 只收到一份当前 Router 信封、两条 digest；摘要 state/acceptance 与原账本一致。准确 digest 的 revision/hash 读取成功，本轮结果在后续请求中保留。
- 三次 provider 捕获后按 UTF-8 JSON 序列化的 messages 为 16748/18346/18879 bytes，Router 信封为 2766 bytes；未新建 Worker，也未重放资源读取。该数值不是精确 tokenizer 或网络包长度。
- 原生窗口确认 Pilot 原对话及两项结果可见，随后显示“两项任务的摘要与原始验收记录一致”。上下文弹层显示 11.8%、6577/约5.6万输入预算；这是 fixture usage，不是实际模型计费。
- 验证后 drain 并确认测试内核停止，再恢复日常 `~/.lake-dev`。实际后端映射到安装后的 Resources/lake，HTTP bundle 与构建字节一致。原 messages、superagentInputs、native_operations、native_approvals、superagent_decisions、superagent_events 六类账本只读全表指纹一致，原会话和四位专员恢复。

## 未交付、限制与回退

本批仅交付 CM 协调上下文及基础范围契约。FM 文件提取/整理/发布、角色知识跨任务写入/读取、生命周期和遗忘、迁移、完整 TaskWorkingSet、真实模型记忆质量集仍未交付；Worker 知识保持 unavailable，N5/V2 与原同意开关不变。未验证 Windows、休眠/断电恢复、实际远端 MCP 及 Grok 内部实现。

预算沿原字节/图像估算，未引入精确 tokenizer。无法核验或未消费的历史保守保留；过大的受保护输入仍可能需要原压缩或明确失败。底层 ADK 档案仍需持久读取，本批保证 provider 工作集不会随已确认 Router 历史线性增长，不宣称磁盘/内存读取为常数开销。

无任务、Memory 正文或 Security 数据迁移，无权限放宽。回退本批请求投影、摘要与预算适配即可恢复旧模型组装；原 ADK 事件及操作/审批/证据/验收账本保留，不通过清账、退款或自动重放操作回退。
