---
goal: 在 Lake Dev 按专员执行监测进展、复核偏航并追踪恢复
version: 1
date_created: 2026-11-07
last_updated: 2026-11-07
owner: Lake
status: 'In progress'
tags: [feature, typescript, superagent, watchdog]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

DeepSeek Harness 的设计文章第 6 节用独立会话定时审阅 Worker 的进展，处理基础设施异常并持续跟踪纠偏。Lake 本期在 TypeScript Dev 运行一个独立于 Pilot 和专员对话的巡检循环。它利用既有模型和任务账本，先确认异常属于哪一次执行，再决定观察、提示或恢复。以下阈值是 Lake 的本地配置。

## 1. Requirements & Constraints

- **REQ-001**: 按项目、Worker、执行会话、内部执行 ID 和 generation 定位。共同任务的公共编号供展示和查询。
- **REQ-002**: 每分钟采样。连续 3 个观察窗口缺少业务进展时触发只读审阅。对长期运行的任务定期对照原始目标和个人分工复核方向，避免把产生新回执等同于实现目标。
- **SEC-001**: 使用当前项目已配置的模型，发送有界、脱敏的任务和工具摘要。审阅会话没有业务工具或操作许可。原 Worker 调用业务工具继续通过当前执行权限与预算。
- **CON-001**: 已停止、已结清、等待回答/审批/指纹及正在运行的命令或子智能体有独立语义。重启、用户停止、权限或 generation 变化让旧干预失效。
- **GUD-001**: 项目默认观察，可切换关闭或允许纠偏。对话保留业务结果；第三栏「执行过程」展示发现、依据与真实处置。Pilot 可按当前项目查询巡检记录。

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: 在 Dev 交付可运行的本机监督闭环。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 在 runtime/typescript/watchdog.ts 基于时钟、业务证据与等待状态认领巡检，按执行持久化观察、审阅、动作和处置结果。每个执行最多每 15 分钟语义审阅一次，每项目每小时最多 4 次。 | true | 2026-11-07 |
| TASK-002 | 在 runtime/typescript/agent.ts 用独立的有界审阅上下文调用模型，在 superagent.ts 接入定时采样、代际和权限核验、明确的原 Worker 纠偏与故障复查。纠偏由宿主根据审阅分类形成；记录排队、失效和恢复的区别。 | true | 2026-11-07 |
| TASK-003 | 在 runtime/typescript/server.ts 提供项目级开关，在共享 contracts 与任务检查器展示当前成员的发现。Pilot 的只读工具可按任务和角色追问依据。 | true | 2026-11-07 |
| TASK-004 | 在 runtime/typescript 的账本与 HTTP/SDK 测试、web-agent/web/test 以及签名 Dev 上验证多专员、恢复、误报和审阅预算。 | false | |

### Implementation Phase 2

- GOAL-002: 把进程停机期间的持续巡检扩展到独立部署。此阶段需要单独的进程生命周期、认证和部署验收，排在本机闭环之后。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | 在后续架构变更中为独立监督进程定义只读巡检与原任务纠偏协议，验证主进程宕机、设备休眠和恢复后的单一执行所有权。 | false | |
| TASK-006 | 在隔离项目积累人工标注的正常长任务、真实停滞与方向偏移样本，按类别报告误报率、恢复结果和额外模型用量，再评估项目默认模式及自然语言规则编辑。 | false | |

## 3. Alternatives

- **ALT-001**: 只依据心跳判断卡住会漏掉模型持续空转。使用语义审阅区分重复尝试、偏航和正常推进。

## 4. Dependencies

- **DEP-001**: 复用 TypeScript 的项目模型选择、SQLite 事务、SDK steering、任务租约、Operation 和目标验收。

## 5. Files

- **FILE-001**: runtime/typescript/watchdog.ts、agent.ts、superagent.ts、server.ts 负责策略、巡检和宿主动作。
- **FILE-002**: web-agent/shared/contracts.ts、web-agent/web/src/SessionInspector.tsx 及相邻展示组件负责项目设置与任务可见结果。

## 6. Testing

- **TEST-001**: 可控时钟推进三次，比较重复无效工作、正常等待、实际新证据、偏航判断、审阅超时和重启幂等。
- **TEST-002**: 共同任务甲等待、乙空转，验证乙能被巡检，甲的消息、审批、Operations 与整单验收独立保留。
- **TEST-003**: 在审阅期间制造进展、停止、关闭设置和换代，旧结果不能送达。检查未决副作用与调用预算。
- **TEST-004**: 检查同一项目的只读查询、每位专员的任务详情、项目模式切换与 Dev 安装来源。

## 7. Risks & Assumptions

- **RISK-001**: 模型可能误判。默认观察、每小时调用上限和证据复查限制影响面，明确区分建议、已送达与已恢复。
- **ASSUMPTION-001**: 首期定时调度随本机 Dev 后端运行。设备离线期间的跨机容灾属于 TASK-005。

## 8. Related Specifications / Further Reading

- [DeepSeek Harness，Super-agent 设计探索，第 6 节](https://zhuanlan.zhihu.com/p/2099987320443237060)
- [作者英文版，第 6 节](https://x.com/DeepSeekHarness/article/2116857257245987236)
- [作者公开原型及与内部系统的差别](https://github.com/deepseek-ai/dsh-superagent-prototype)
- [Lake 二期规划，TASK-011 / TASK-012](architecture-lake-superagent-2.md)
- [Lake 宿主与执行验收边界](../agent.md)
