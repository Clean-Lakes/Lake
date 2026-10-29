# C1：策略新增执行退役

> 后续状态（2026-10-29）：旧资产应用与兼容管理已完全退出；当前入口、归档和拒绝规则见[退出契约](legacy-asset-exit.md)。本文保留当时阶段的设计记录。

实施基于 `develop@081d66520dfc8f958a8eebbd84b675a183113613`，承接 [清理计划](../../plan/refactor-harness-inspired-cleanup-1.md)。本阶段停止新增执行，不迁移人工偏好，不删除旧表或批量清理正文。

## 运行和接口

- `onlineEnabled` 对所有配置返回 false。Configure、普通/恢复轮次忽略旧 learn/correct 标记，修订工具不进入目录；直接恢复调用也拒绝 `revise_readonly_strategy`。普通 ADK、SRE 只读重采样、协议恢复、审批及操作账本保持原边界。
- Web 不再启动策略学习和实验 worker，不挂接专用纠错/前台争用回调；旧 tick/执行器函数保留期间仍有退役守卫。前台不采集新 StrategyOutbox，旧 Outbox 不物化、不生成候选；原引用保留为惰性兼容数据，C3 再拆存储字段。
- host/project 校验后，POST sources/proposals/experiments、resume/save-candidate 等已退役操作返回 HTTP 410，code 为 `strategy_execution_retired`。拒绝在旧回执重放前执行。Store 队列、租约检查和候选完成入口亦拒绝；无工作可领取。
- 设置 PATCH 中 learn/correct/online 任一 true 返回 410。新前端保存人工开关时固定传 false；GET capabilities 的 learn/correct/onlineCorrect 为 false，executionRetired 为 true。保留旧字段以兼容读取，但不代表执行能力存在。fixtures 仅返回空列表及 retired 模式。
- 人工资产 CRUD、版本采用/停用、审核/拒绝、显式晋升、条件限制、使用历史、来源撤回与报告清理仍受原权限保护。`master/apply` 不随学习退役关闭。此阶段仍保留旧策略主标签，待 C2 收敛。

## 持久退役与恢复

业务库在 OpenStore 的进程锁与恢复事务内先执行 `retireStrategyExecution`，再退役 jobs；先于 server worker 启动。设置 JSON 增加：

| 字段 | 含义 |
| --- | --- |
| `executionRetirementVersion: 1` | 已应用 C1 退役策略，非用户可开启的运行开关 |
| `retiredExecutionChoices` | 首次退役时原 learn/correct/online、同意版本、设置 revision/epoch，仅保存标量审计信息 |

原 executable flags 清零，revision/epoch 单调推进；记录一次退役事件，原人工绑定和原 LegacyOnlineConsent 不变。保存后继续保留该审计记录；重复启动不重复迁移。有效设置额外固定关闭已退役能力，防止老数据被当作有效选择。

| 历史任务 | 处理 |
| --- | --- |
| 未派发 queued/leased-none | cancelled，撤销租约，标记退役 |
| intent/started/unknown 或子调用结果未知 | awaiting_reconciliation/unknown，清除可执行租约；runtime ID、requestHash、结果和费用预留保留 |
| 已知完整结果但尚未形成资产 | 停止后续提交；保留已保存结果，不重新调用或自动采用 |
| succeeded/failed/cancelled 终态 | 原任务终态不改；未完成子调用仍保留未知，不将原失败改成成功 |

ADK `nativeCorrection` 的 JSON 增加 `retired:true`。空停止原因或 awaiting_user 的旧控制器转 cancelled；有在途调用/请求保留 awaiting_reconciliation。已完成/失败等原终态保留，原 call ID、计数、usageUnknown 和 token 不清零；重复恢复不重写。`nativeOperation` 的 dispatched→unknown 仍由原 ADK 恢复处理。

业务 SQL schema 仍为 v6，原迁移、hash、不可变触发器和正文/血缘表未改；ADK 使用原表，不新增模型循环。回退老二进制只能用兼容隔离副本；清零选择可防止自动重启旧任务，但更旧程序本身没有 C1 的 API 拒绝规则，不能宣称可以约束旧代码的手动开启行为。

## 界面

设置只保留人工总开关与已采用资产应用。去掉积累候选、在线实验和同意控件；历史学习页去掉登记/生成，实验页去掉场景选择和新建 A/B。已有候选审核、来源撤回、原文清理、导出和历史纠错卡保留，不提供旧实验继续入口。未知结果显示为待核实，不显示为仍在后台运行。

## 验证与测试调整

新回归覆盖：

- 配置旧 true、恢复配置、伪造旧修订调用都不能注册/执行控制器。
- 旧成功回执、过时 API 和重新启用请求不能复活执行；错项目仍先拒绝。
- 业务设置迁移保留人工绑定、精确正文及原选择；未派发、intent、running 和终态分开处理；真实子进程重复启动不重发。
- ADK 旧报告恢复幂等，未知身份、token、请求数和失败来源保留。
- HTTP→官方 ADK 普通纠正仅执行主任务，无辅助请求；项目记忆明确授权/拒绝仍分别工作。
- SRE 超时后取得真实新采样，原 unknown 操作和新成功操作均保留；旧启用请求被拒绝后仍可正常调查。
- 前端保存丢弃旧执行字段，继承人工应用仍保留项目 CAS；历史卡和面板保留且没有新执行控件。

旧在线恢复成功、自动学习、自动交付和新建产品 A/B 的正向测试已退出，改以退役拒绝/历史夹具测试；没有测试专用运行开关。纯数据契约、迁移、项目范围、来源撤回、人工版本、Skills 和普通执行回归继续保留。历史候选/优化夹具直接构造已发布表结构中的记录，不调用已退役队列来伪装历史数据。

实际命令、干净实测提交、签名 Dev、数据逐行比较与隔离旧版本结果见 [C1 验证记录](../validation/strategy-execution-retirement-c1.md)。Windows 原生界面未在本机验证，不触发额外 CI；没有重跑真实模型收益实验。
