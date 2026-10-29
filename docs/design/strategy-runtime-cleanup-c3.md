# C3 运行依赖清理

> 后续状态：C3 已合入 #117；文档/脚本和本地集成收尾见 [C4 手册](memory-compatibility-c4.md)与[验收](../validation/memory-compatibility-c4.md)，Windows 原生缺口按用户选择保留。下文描述 C3 当时范围。

日期：2026-10-29。基于 `develop@cd75e2c7d0acb71e61e73d19bd12ceec92486c5d`（N5 #116 已合入）。最终已同步 develop@16483bd2（#115）；源码与验收提交见下文记录。本阶段落实[清理计划](../../plan/refactor-harness-inspired-cleanup-1.md) S01～S04；自然记忆仍为实验，默认使用/积累开关不变。没有引入 Harness² 依赖或另一套 Agent 循环。

## 普通任务的变化

| 之前的依赖 | C3 后的行为 |
| --- | --- |
| 按精确文案将内嵌提示词划为可优化槽位 | 直接按固定规则组合，角色与当前任务仍单独分层；17 组原始提示词字节基线一致，仅 OS 归一化 |
| 每轮/工具前执行已退役控制器的空钩子，携带旧 epoch/预算配置 | 删除控制器、预算预留/结算、修订采样、停止拦截及 AI Config 的旧学习/纠错字段；真实目标、权限、审批和操作账本照常检查 |
| 终态尝试旧候选快照采集，旧 outbox 可物化正文 | 删除前缀判断、采集和物化路径；仅对已有 outbox 做准确 hash 收尾确认，不能生成候选 |
| 宿主仍能直接运行旧变体 actor | actor 实现移除；兼容入口立即返回 `retired/strategy_execution_retired`，不调用回调、模型、桥接或创建 Home |
| 每次 provider 请求先写实验清单 | 产品默认不记录；仅宿主代码显式设置 `Engine.RecordPromptDiagnostics=true` 可采集，属于尽力诊断。诊断构造/写入失败不阻断普通请求；取消、真实会话存储、授权和来源撤回仍按原边界处理 |

`RecordPromptDiagnostics` 不来自 JSON、旧学习开关、API 或界面；正常 Web/CLI/专员不主动设置它。清单失败不产生当前请求引用；进入新请求时清除旧当前引用，旧 artifact 不删除。恢复、格式修复和压缩沿官方 ADK 原流程，不存在纠错额度拦截。Skill 加载照常，新增 SkillSnapshot 仅随显式诊断记录；旧快照仍可解码。

自然记忆的终态/压缩前增量捕获、后台优先级、按范围提供、按版本读取以及每请求/工具前重验是有效链路，全部保留。旧清单与新偏好访问记录是不同数据；停写前者不会停用后者。

## 保留的兼容代码及理由

| 保留项 | 约束与删除条件 |
| --- | --- |
| `StrategyProvider` 与准确采用选择、失效检查 | 复杂条件旧资产尚不能等价承接为新偏好；继续原绑定、范围和撤回，不自动转成无条件偏好，也不向专员扩大继承。待用户确认承接且零调用者后再删 |
| `nativeCorrection` SQL 结构、旧报告类型与受限历史卡 | 原 schema/身份/预留/未知账本保真；启动仍执行幂等退役恢复。不能以旧记录触发新模型请求、自动续跑或退款 |
| `StrategyTurnSnapshot` 字段、seal/valid、旧 outbox/ACK 与输入限额 | 旧 JSON 的 hash 输入不变；仅完成旧宿主收尾，不回溯消息补学习。新 N2/N4 outbox 独立工作 |
| PromptManifest/PromptBaseline/SkillSnapshot/历史读取 | 旧历史可查、可脱敏导出，准确资产版本仍可管理。默认不新增实验清单；不能把“准备”或旧报告改成使用收益证明 |
| 旧设置/预算字段、资产与报告 SQL 及纯元数据 | HTTP/数据库兼容、历史解释和校验仍需；已从活动 AI 配置移除，不修改旧迁移或 hash。没有 drop 表或批量删除正文 |
| 旧变体 input/result 类型与拒绝 stub | 保持历史宿主测试/数据形状可编译和明确报错，实际执行器已删除。原 P8/R5 真实 actor 入口显式拒绝，不能重新运行后覆盖旧报告 |

无生产调用者的 `OnlineProgress`/`SnapshotProgress` 仅留在测试，保留冻结的历史评分语义。其他仍被历史解码、选择、报告或测试引用的 `internal/strategy` 类型不按名字整包删除。通用 `ModelActivity`、项目记忆、手写 Skills、主机 runtime 修复、SRE/Pilot、签名和 Dev 快跑不属于退役代码。

## 验证与后续

新增普通请求无清单、可选诊断失败继续、真实 canonical 存储失败停派发、退役 actor 零回调/IO、旧快照 hash/准确 ACK、失败读取无自动重放及生产 AST 依赖检查。现有撤回、unknown、审批、模型切换、压缩、Skills、自然记忆与全量回归继续运行。提示词基线由改动前 develop 生成，不能从新实现自证。

实际源码、命令、Dev 升级和模型冒烟见 [C3 验收](../validation/strategy-runtime-cleanup-c3.md)。C4 仍负责 README/旧脚本/CI 引用的最终梳理及集成兼容矩阵；本阶段没有重跑旧收益试点、宣布新记忆正式可用或默认开启。Windows 本阶段只交叉构建；N5 的一次手动 CI 授权不延伸到 C3。
