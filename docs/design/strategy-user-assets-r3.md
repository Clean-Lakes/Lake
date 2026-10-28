# R3：用户资产审核与显式晋升

> 历史设计：保留当时交付、判据和结论。当前自然记忆按[重塑计划](../../plan/feature-natural-memory-1.md)与 [N3 契约](natural-memory-idle-n3.md)推进；旧候选提取、在线纠错和新增产品实验按 [C1](strategy-execution-retirement-c1.md)退役，不能据本文重新启用。旧人工内容和原运行绑定仍从次级兼容入口管理。

基于 PR #72 合入后的 develop `6064045` 开发，PR #67 保留。目标是用户可见、准确版本确认、受限血缘与拒绝抑制；不加入自动采用、自动跨项目晋升或额外模型请求。P8 的收益结论仍为 inconclusive。

## 生命周期与 API

- 手写/编辑正文默认为 accepted（仅用户确认）；`job:` / `optimizer:` 生成版本默认为 pending。审核状态不修改不可变 verification。历史已有采用绑定的准确版本迁移为 accepted，保留原绑定及其版本。
- `POST <scope>/assets/:id/review`：`ref`（准确 id/revision/hash）、`expectedDecisionRevision`、`decision=accepted|rejected`、`reasonCode=reviewed|not_reusable|duplicate|incorrect|too_specific|other`。只由所有者范围审核最新版本；CAS 与幂等，拒绝会停用该版本及依赖它的晋升内容。采用仍需另一显式操作；原有准确版本采用也记录接受决定，拒绝版本不能直接采用。
- `POST /api/projects/:project/strategy/assets/:id/promote`：准确 `ref`、`confirmed=true`、`draft`（expectedRevision=0、标题/类型/正文/applicability/assessment）。校验所有者项目、原版本仍为最新/可用/已接受、完整脱敏预览及已确认；创建新的 user 资产而非修改 scope，不自动建立采用绑定。相同原版本和正文重复晋升拒绝；相同幂等键返回原结果。
- assessment 固定为 conditions/evidence/limitations 三项 UTF-8 用户说明，每项最多 2,000 bytes，与 revision 一同保存；晋升的 conditions/limitations 必填。用户可记录验证依据与时间，但不授予 fixture/multi-task 验证等级。自动匹配、期限/待复核与使用反馈归 R4。
- 拒绝记录按 scope+sourceSetHash+规范化正文 hash 保存，reasonCode 有界，不存源文本。同来源入队直接拒绝，已排队/租约检查也拒绝；不同来源提取到同内容时只记录 rejected_candidate，不新增资产。仅已派发调用仍记真实费用，不为抑制假装未调用。删除、重启和重新接受不清除拒绝摘要。

## 隐私与血缘

晋升 revision 的公开 source 仅是对最终正文的用户确认。原始项目 ID/来源/消息不复制到 user revision、导出或模型上下文；host 内部 strategyPromotions 持有准确原 revision/hash 依赖，derived_from 连接真实版本。普通全局/项目 B 血缘分页只报告存在受限记录，不能读取私有节点、ID、摘要或正文；项目 A 仍可审计。

原来源可用性由宿主内部查询，只向公开视图返回可用性布尔值。撤回/删除清理派生正文与 assessment、停用绑定，保留 immutable refs/hash/血缘/拒绝及审计。后续手动编辑继承非手写来源和晋升依赖，不能通过编辑断链绕过遗忘。归档项目/资源采取保守停用并撤回该项目来源；恢复不复活内容。在途已注入依赖的上下文按既有策略失效取消，不重放资源操作。Skill 派生资产仍检查原 Skill 读取权限、启用和 hash，不因公开正文而放宽。

公开的标题、正文、条件及经验说明是用户确认可跨项目展示的内容，必须在晋升预览中去敏；自动扫描不代替用户审核。当前身份仍是本机用户，并未新增团队多租户。准确绑定、新版本不自动采用、项目覆盖全局、回滚及导出保留原规则。

## 存储与兼容

策略 schema v5 复用原业务 SQLite；增加 strategyReviews（版本决定 CAS）、strategyAssessments（不可变版本说明，可遗忘）、strategyPromotions（不可变受限依赖）、strategyRejections（hash 抑制）。不改 ADK 主存储或操作账本。v1–v4 在事务升级前生成 0600 兼容副本；DDL 冲突整笔回滚，未知 schema 在恢复写入前拒绝。旧 v4 程序不能读取 v5；回退仅限隔离的升级前副本，不能覆盖当前数据。

R3 为旧 API 新增可选 assessment；含新结构的写入重试仍由摘要/CAS保护，跨版本的旧幂等请求可能返回冲突，需刷新核实已保存结果，不能无条件重发。

## 验收

回归覆盖 A08/A09：准确版本审核/晋升、伪造字段和跨项目拒绝、公开视图与受限血缘、无自动采用、编辑不换绑定、撤回沿编辑链生效、重启不复活、同来源/同正文拒绝去重、项目归档/恢复、Skill 权限及在途跨项目撤回取消；同时保留迁移回滚、未知调用和原生操作账本回归。

代码提交 `ed51284943e04dafb6a0c091bcf115fbb9b90f71`，干净源码签名构建；验收记录提交仅改文档。计数及后端 SHA-256 见 [R3 验收记录](../validation/lake-strategy-user-assets-r3.json)。

- `go test ./...`、`go vet ./...` 与 `python3 scripts/check_adk_runtime_boundary.py` 通过。
- `go test -race ./internal/ai ./internal/web ./internal/strategy -run '^(TestStrategy|TestOnline|TestSRE|TestMultiAgent)' -count=1 -timeout=8m` 通过；最后补充 Skill 依赖检查后，再运行 `go test -race ./internal/web -run '^(TestStrategy|TestOnline)' -count=1 -timeout=6m` 通过。
- `web-agent` 中运行 `corepack pnpm check`、`corepack pnpm test:frontend`（423/423）、`corepack pnpm build:web` 通过；保留已有大 bundle 提示。
- `scripts/run_lake_dev.sh` 签名构建并直接运行，无 ZIP/DMG。全新私有 Home 的 loopback SSE/官方 ADK 演练真实采集两个候选，发出 3 次业务、2 次无工具辅助请求；准确审核晋升后项目 B 实际模型请求含公开正文，不含原私有正文。编辑仍采用旧版，来源撤回后两个晋升版本均不可读；拒绝同来源返回 409、重启额外模型请求 0，两份 SQLite integrity_check 和业务 foreign_key_check 通过。
- 原生 Dev 检查明暗主题、920×760、共享下拉的方向键/选中/焦点和边缘裁切；审核与晋升确认均以 Escape 返回，不产生写入。晋升预览勾选前按钮禁用，勾选后可进入最终确认。仅用明确标记的临时项目检查表单，随后归档；恢复原项目、浅色主题及窗口尺寸，未改用户已有资产。
- 固定 `~/.lake-dev` 已运行 R3，schema v5 和权限 0600 的 v4 兼容副本已核实，应用/学习保持开启，在线纠错关闭。无真实供应商验收调用。

未触发手动 CI、生产发布或安装包构建；macOS 结果不代表 Windows 实测，也不证明模型收益。
