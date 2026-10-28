# N3 空闲增量整理验收

日期：2026-10-28。#112 经简单检查与针对性 Go 验证后按用户授权 squash 合入 develop，提交 `409d27063f59030b406544cc35484edac0a4e8ce`；原远端/本地 `codex/natural-memory-intent-n2` 已清理。N3 从该提交开发，随后合入最新 `origin/develop@1d83ac5a29593cca3835206d8aed4ffdd8842e94`。

最终完整 Go、race/vet、边界/交叉编译、模型验证及签名 Dev 后端为 **`da294ba32ecdf621e5ca143a2d1a6af82a6346c6`**，构建 dirty=false。后续提交只补验收文档和报告。契约见 [N3 设计](../design/natural-memory-idle-n3.md)。

## 检查结果

| 项目 | 命令或操作 | 结果 |
| --- | --- | --- |
| 全量 Go | `go test ./... -count=1 -timeout=8m` | 通过；Web 206.256 s，AI 63.956 s |
| 相关并发回归 | `go test -race ./internal/web ./internal/ai -run 'Test(Natural\|Memory\|ProjectMemory\|StrategyRetir\|StrategyMemory\|Retired)' -count=1 -timeout=6m` | 通过；Web 33.619 s，AI 3.622 s |
| 静态检查 | `go vet ./...`、`python3 scripts/check_adk_runtime_boundary.py` | 通过；原官方运行入口与 provider AST 边界保持 |
| Windows 交叉编译 | `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -o /tmp/lake-n3-windows-check.exe ./cmd/lake` | 通过；没有运行 Windows 二进制/UI 或手动 CI |
| Web | 项目固定 pnpm `check`、`test:frontend`、`build:web` | 类型检查、541 项测试、构建通过；构建保留既有 chunk 体积提示 |
| 本地运行 | `scripts/run_lake_dev.sh`、`codesign --verify --strict bin/lake` | 新 Web 与持久身份签名后端通过；来源 manifest 匹配源码和二进制 hash |
| 数据与兼容 | 两库备份、真实重启 hash、隔离 N3 → 已安装旧 Dev → N3 | 通过，详见下文 |

新增 [N3 回归](../../internal/web/natural_consolidation_test.go)覆盖六条批量上限/尾部、稳定来源身份、来源支持/合并撤销、明确更正/矛盾保留及拒绝 CAS、迟到结果全批回滚、条件不等价拒绝、输入预算不推进覆盖、队列满保留真实持久 outbox、未知预留恢复、次日预算唤醒、同 topic 跨范围隔离与全局来源隐私、相关同意关闭才取消批次、删除/遗忘防复活、独立迁移及 DDL 失败原子性。严格协议继续拒绝伪造原话和未授权更正。AST 回归阻止产品重新调用旧候选/实验派发器。

已有 N1/N2、C1 退役、项目记忆 V1/V2、Skills/工具权限、恢复与账本回归保留；原测试调用已删除的 no-op worker 处改为驱动当前 memory worker，没有删除原边界断言。

## 真实模型与发现的问题

所有输入为虚构表达偏好，实际调用原 `ExtractMemory` 无工具适配器和临时 Store 事务；仅私下读取已选 Dev 模型 `deepseek-flash` / OpenAI 凭据，不发送真实用户会话或业务库。普通测试默认 skip 显式 opt-in 评测。冻结的 60 例、3 轮与原 SHA256 `922f2a4f4b30ae23ba5c178af1456a0a635fff69f1b37505b4bd4f62bc21f084` 未变，判据未放宽。

| 最终评测 | 次数 | 结果 | 已报告输入/输出 tokens |
| --- | --- | --- | --- |
| 固定意图集合，MaxOutput=2048 | 180 | 每轮明确长期召回 30/30，误写/错误范围/技术失败均 0；精确决策 55/55/55（各 60） | 284,639 / 34,041 |
| 八类双来源批次，MaxOutput=4096 | 24 | 三轮全部通过：同义、含糊矛盾、明确更正、全局/项目分开、引用/临时、条件差异、独立主题 | 39,030 / 10,672 |
| 已有 v2 多来源目标，MaxOutput=4096 | 9 | 三轮同义/矛盾/更正全部通过，实际 Store 事务参与 | 14,437 / 1,710 |

逐例结果：[意图](natural-memory-n3-model-intent.json)、[批次](natural-memory-n3-model-batches.json)、[已有目标](natural-memory-n3-model-existing.json)。来源授权继续由真实 Store 检查；没有另行发明模型可核验的“来源准确率”字段。模糊表达中 ignore/review 仍有差异；通过判据不是全部分类正确，也不证明对业务任务产生收益。

保留的失败和修改过程见[评测历史](natural-memory-n3-evaluation-history.json)：

- 早期两次 180 例评测与一次 9 次诊断暴露嵌套 schemaVersion 缺失、多余字段/关系不一致。完整嵌套示例修正后旧协议仍严格拒绝非法结果，没有删除字段或放宽解析器。
- 首次批次评测为 23/24，全局/项目独立目标有一次全批延后，没有写入错误范围；补充同范围目标约束和确定回归后复测通过。
- 首次已有目标评测为 6/9：三次含糊矛盾被模型误判 correction，原话中没有明确更正依据，宿主拒绝。此前两次真实 Dev 留下 invalid_output；该独立评测用同样的合成原话复现了未授权更正误判，真实失败响应本身未持久保存。修复为输入显式提供宿主的 `explicitCorrectionAllowed`，模型必须区分“长期”与“可替换”；宿主仍独立检查准确原话和目标版本。修复后该集合 9/9，再重跑原 180+24 例通过。

全部探索、诊断与最终集合共 **999 次**分类/整理模型请求，最终集合为其中 213 次，费用未估算金额；历史报告保留各轮已知 token 用量。真实 Dev 的五次后台派发和主会话调用另计。这些请求仅供有界开发验证，不是产品每轮固定增加的调用量。

运行最终评测：

```sh
LAKE_N3_EVAL_HOME="$HOME/.lake-dev" \
  LAKE_N3_EVAL_REPORT=/tmp/n3-intent.json \
  LAKE_N3_BATCH_REPORT=/tmp/n3-batches.json \
  go test ./internal/web -run '^TestNaturalConsolidationModel(Evaluation|BatchEvaluation)$' -count=1 -timeout=6m -v
LAKE_N3_EVAL_HOME="$HOME/.lake-dev" LAKE_N3_EXISTING_REPORT=/tmp/n3-existing.json \
  go test ./internal/web -run '^TestNaturalConsolidationExistingTargetModelEvaluation$' -count=1 -timeout=3m -v
```

## 签名 Dev 实测

macOS 26.4 arm64。正常退出 Dev 后，从核对路径的原终端停止后端；两库使用 SQLite backup API 一致性备份到 `~/.lake-dev-backups/n3-before-*/`，目录 0700、文件 0600、integrity_check 均 ok。生产 Lake 与 `~/.lake` 未操作。复用既有签名原生 shell（来源 `54a117c9`），运行上述最终源码的签名后端和新页面，不制作 ZIP/DMG、不替换安装包；本次没有原生源变更。

首次升级前后 projects/sessions/strategyAssets/naturalPreferenceEntries/naturalPreferenceRevisions 五张表逐行 hash 相同，3 个 N2 修订仅补来源引用；自动 N3 迁移备份一份，没有继承同意或扫描旧对话。重复启动后全部 natural 表 hash 相同。

新建纯虚构项目“**N3 空闲记忆验收 20261028**”，经界面仅开启项目自动记忆，全局始终关闭；该项目旧记忆 use/extraction 关闭，Pilot/子代理关闭，会话提示要求只回复文本，不调用工具。等待准确的新用户 messageId 对应 replyTimings 完成，再判断后台结果，避免将前一轮 completed 当作新轮次完成。

| Dev 场景 | 持久结果 |
| --- | --- |
| 连续两条“以后这个项目的答复固定用中文”“本项目后续的回复都使用中文” | 一次后台请求，同一条目 v2，保留两个真实来源；两次前台均先完成；一条更新提示 |
| 修复前两次无明确更正的英文要求 | invalid_output 被拒绝（随后诊断复现为未授权更正），保留原 v2 和两个 deferred 来源，前台正常完成；失败没有被删掉或标为已覆盖 |
| 修复后的相同长期矛盾，新真实消息 | 保存待核实 conflict，原 v2 中文正文不覆盖 |
| “更正本项目长期偏好：以后答复固定使用英文” | v3，原矛盾 superseded |
| 再次发送完全相同的更正原话 | 本地合并 v4，两个来源，零新增 provider 派发 |
| 点击轻提示“查看”“撤销此项更新” | 展示准确 v3 → v4，撤销生成 v5、恢复原一个来源，提示消失，不覆盖其他历史 |
| 新设置与旧入口 | 主标签为记忆/实验；旧资产与条件、候选/来源、历史报告和 N1 承接从折叠入口可访问；没有新增旧提取/实验按钮 |
| 状态显示 | 已处理 5、暂缓 2；暂缓不是成功覆盖，未掩盖修复前失败 |

[结构化实测记录](natural-memory-n3/dev-scenarios.json)。集成时另修复了状态岛改动导致提示落在原生标题拖动区的问题；提示改为独立定位到标题下方，查看/撤销已在原生窗口实测可点击。

浅/深主题和 1162×852 窄窗口实测：正文、边框、圆角、滚动及按键操作可用；下拉 Escape 只关闭选项，Tab 保留设置内焦点。截图：[浅色](natural-memory-n3/light-narrow.jpg)、[深色](natural-memory-n3/dark-narrow.jpg)。完成后恢复浅色和宽窗口，保留 Dev 运行。

隔离两库副本未复制任何 secrets/供应商文件，运行 N3 → 已安装旧 Dev → N3，全部 natural 表与 v5 正文/来源完全一致，两库完整性 ok；旧执行设置仍关闭，无恢复派发。此结论只适用于本次旧 Dev 源码 `54a117c9`，不代表任意旧版可回退。禁止用旧备份覆盖当前真实 Dev 或生产数据库。

## 尚未交付和限制

N3 仍是受控实验，默认不因升级开启。N4 压缩前额外捕获、N5 新自然偏好的跨会话使用未实施；主对话按当前上下文回答不能证明新召回生效。运维 V2 门控仍关闭，资源事实/条件经验质量与 Windows 原生验收未完成。本次只交叉编译，没有额外 CI、生产合并或发布。

同批重复旧事实键、输入/支持数量上限或版本冲突会保守延后，不保证自动化解；模型仍可能误判语义或产生非法输出。每日预算是 UTC 次数上限，不能换算为确定金额或未知退款。历史 AI 变体/共享夹具、旧 JSON/数据库与兼容管理仍有依赖，C3/C4 没有整体完成；旧设计已加历史标识，原 P8/R5 的 inconclusive 结论保持不变。
