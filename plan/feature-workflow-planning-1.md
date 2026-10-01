---
goal: 工作流在执行前依据历史证据自主调整计划
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [workflow, agent, planning, recovery]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

现有工作流只在明确命令失败后调用恢复专员，无法自行修正超时和并行扫描配置。增加默认运行前AI规划，以原任务和同工作流同操作的历史状态、耗时为依据，调整本次执行期限和串行依赖；保存调整证据，下次运行继续参考历史。

## 1. Requirements & Constraints

- **REQ-001**: adaptive模式在第一次远端执行前调用规划器；fixed模式跳过；显式恢复保持原运行计划，不重新规划已执行步骤。
- **REQ-002**: 规划只能延长1–3600秒内的执行期限、增加同资源成功分支的依赖；原目标、命令、主机、条件、步骤集合和已有依赖不可改变，循环和虚构历史证据拒绝。
- **REQ-003**: 原保存定义和历史运行快照保持不变；本次有效计划与调整前后值、理由、证据运行ID在首次执行前原子保存，并进入会话卡片。
- **REQ-004**: 规划最多两次模型请求、总期限20秒、输出最多16KiB；失败沿用原计划并明确说明，用户取消则不执行远端操作。
- **REQ-005**: 提供workflow plan只评估命令，不运行SSH；明确失败仍走原有有验证的专员恢复，未知结果不自动重放。
- **SEC-001**: 不扩大操作范围、资源授权或审批；规划器没有远端工具；不输出模型密钥或SSH私钥，不读取Keychain。
- **CON-001**: 只通过签名脚本构建与安装；用户草稿及侧栏宽度保留。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 计划调整受验证且在执行前持久化。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | lake/workflow/planning.go实现PlanProposal、PlanningReview、PlanningExecutor、ApplyPlan；spec.go保存planning字段；engine.go在StartWithTargets创建运行后规划、验证并保存，取消中断不执行。 | Yes | 2026-10-01 |
| TASK-002 | lake/store/workflow_planning.go增加同工作流历史读取和仅全pending时原子保存计划及事件；覆盖越界修改、计划事件、旧快照不变。依赖TASK-001。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: Lake AI、CLI和图形界面使用同一规划结果。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | cmd/lake/workflow_planning.go实现受限模型规划和同操作历史证据，格式校验最多修正一次；workflow_adaptive.go实现PlanningExecutor；workflow_cli.go增加plan及--from-run历史快照评估；workflow_tools.go说明自主规划。依赖TASK-001、TASK-002。 | Yes | 2026-10-01 |
| TASK-004 | Progress、SpecialistCall及bridge工作流轨迹携带planning；SpecialistCallCard.tsx显示紧凑调整清单；timeline保留实时和历史规划，README说明默认与fixed行为。依赖TASK-003。 | Yes | 2026-10-01 |
| TASK-005 | 本地SSH、伪模型及状态持久化测试覆盖有效调度、非法计划、固定模式、取消及恢复不重放；前端验证历史规划、响应式展示；相关race/vet/前端测试和构建通过后签名安装，空闲重启。依赖TASK-004。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 针对du/find硬编码时长不能推广到其他任务，采用受约束的模型规划。
- **ALT-002**: 超时后自动重复未知命令可能重复副作用，继续保留未知结果保护。

## 4. Dependencies

- **DEP-001**: 原有SSH逐步骤执行期限、资源审批和模型配置加载。
- **DEP-002**: 已有工作流事件、运行快照和会话轨迹。

## 5. Files

- **FILE-001**: lake/workflow/planning.go、planning_test.go、spec.go、engine.go；lake/store/workflow_planning.go，持久化行为由planning_test.go覆盖。
- **FILE-002**: cmd/lake/workflow_planning.go、workflow_planning_test.go、workflow_adaptive.go、workflow_adaptive_test.go、workflow_cli.go、workflow_tools.go、bridge.go、bridge_test.go；lake/store/conversation.go、agent_event.go。
- **FILE-003**: client/desktop/frontend/src/workflowPlanning.ts、SpecialistCallCard.tsx、App.css、timeline.ts、timeline.test.mjs；README.md；本计划。

## 6. Testing

- **TEST-001**: 合法模型提案改变本次期限及执行顺序，原定义不变；非法依赖、命令字段、缩短期限、超范围或伪造证据被拒绝。
- **TEST-002**: 固定模式不调用模型；取消不执行；恢复使用原有效计划且不重跑成功步骤或未知写操作；不允许执行开始后再修改计划。
- **TEST-003**: 历史证据只取相同工作流、资源、命令和目标，且不将远端输出作为规划指令；规划格式错误最多修正一次，失败可见。
- **TEST-004**: 图形卡片展示调整前后和原因，完成后及会话重载仍保存；窄布局对齐；签名构建通过。

验证结果：

- `go test -race ./lake/workflow ./lake/store ./cmd/lake`与对应`go vet`通过；前端38项测试、桌面和Web生产构建通过。
- 本地SSH集成测试验证模型延长期限后命令只执行一次且成功；计划在远端调度前保存，串行依赖生效。
- 使用已配置真实模型评估原历史运行，AI自行建议两项扫描从20秒延长到600秒，并让大文件扫描等待一级目录扫描成功；评估前后原保存定义和全部4个运行快照哈希一致，未新增运行、未执行远端扫描。
- 使用实际组件和产品完整样式，220、320、480及820像素容器均无内容溢出；正常卡片最大宽度680像素，调整清单默认折叠，原因可展开。
- 已通过签名脚本安装`Lake-20261001-191142-40699.app`至`~/Applications/Lake.app`，深度签名验证通过；空闲重启后侧栏宽度335像素及用户草稿保留。临时预览文件、页签和服务器已清理。

## 7. Risks & Assumptions

- **RISK-001**: 本次运行前规划用于v1工作流；模型可能评估错误或不可用，受限调整不能保证任务总能成功，仍按实际执行证据判定结果。
- **ASSUMPTION-001**: 用户要求AI自主调整任务，授权增加默认adaptive规划；当前未知远端任务不重新执行。

## 8. Related Specifications / Further Reading

[既有恢复机制](feature-workflow-adaptive-1.md)
[执行期限配置](refactor-workflow-scan-timeout-1.md)
[构建规则](../AGENTS.md)
