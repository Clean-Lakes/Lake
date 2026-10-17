---
goal: Lake 根据目标与证据自主决定调查拆分和子 Agent 调度
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
owner: Lake
status: Completed
tags: [refactor, multi-agent]
---
# Introduction

![Status: In progress](https://img.shields.io/badge/status-Completed-brightgreen)

移除自然语言关键词触发的固定巡检、固定采样前序和自动 Beacon。模型选择工具、任务、调查职责、目标和复核时机；运行时验证资源范围、只读能力及预算。

## 1. Requirements & Constraints

- **REQ-001**: 通用聊天首次推理发生在任何主机采样或子任务注册之前；多节点和“继续”不能自动创建任务。
- **REQ-002**: delegate_investigation 支持模型决定的 1–7 个调查任务和可选 Beacon；子模型自主选择观察工具，无固定采集前序。
- **REQ-003**: Scout 可选择 observe_cluster 查询身份、节点、Pod、事件和资源指标；任意 Shell 和变更仍不提供给子 Agent。
- **REQ-004**: 委派报告包含服务端资源名称、别名、证据来源、时间和复核状态，避免 Lake 猜测目标或重复采集。
- **SEC-001**: 保留关闭多 Agent、目录范围、父权限、主机信任、禁止本机执行、取消及并发/用量上限；不读取 Keychain、不输出凭据、不推送。
- **CON-001**: 显式保存的工作流执行规则保留，入口保持隐藏；自然语言聊天不使用固定工作流。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 删除聊天固定策略，保留受控执行能力。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/web/agent.go、internal/ai/engine.go、turn_input.go、types.go 删除自动巡检、采样前序、自动复核；删除 auto_survey.go 路由与对应旧测试。 | ✅ | 2026-10-13 |
| TASK-002 | internal/ai/multi_agent.go、catalog.go 添加模型调度说明、最多七个调查任务、可选复核及资源/证据映射；每个子模型自主调用观察工具。依赖 TASK-001。 | ✅ | 2026-10-13 |
| TASK-003 | internal/ai/cluster_observations.go、agent_observations.go、tools.go 添加只读 Kubernetes 观察；验证集群节点 IP 与已选择目标，返回实际来源和缺失项。 | ✅ | 2026-10-13 |

### Implementation Phase 2

- **GOAL-002**: 验证调度由模型产生并更新调试服务。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | internal/ai/model_dispatch_test.go、cluster_observations_test.go、internal/web/model_dispatch_test.go 验证不委派、五任务并行、模型选择复核、取消、越界和集群工具。更新 multi_agent_test.go 显式请求 Beacon。依赖 TASK-001–TASK-003。 | ✅ | 2026-10-13 |
| TASK-005 | 运行 AI/Web race 回归和前端检查；scripts/build_lake.sh 签名构建；独立调试服务空闲后加载新二进制并验证页面。依赖 TASK-004。 | ✅ | 2026-10-13 |

## 3. Alternatives

- **ALT-001**: 仅修改提示并保留固定触发器；首次推理仍发生在既定任务完成后，不满足要求。
- **ALT-002**: 子 Agent 开放任意命令；任务自主性通过选择受控工具实现，无需扩大写权限。

## 4. Dependencies

- **DEP-001**: 现有独立子引擎、目录范围、服务端证据登记及签名脚本。

## 5. Files

- **FILE-001**: internal/ai/engine.go、turn_input.go、types.go、multi_agent.go、catalog.go、tools.go、agent_observations.go、cluster_observations.go。
- **FILE-002**: internal/web/agent.go、internal/ai/model_dispatch_test.go、cluster_observations_test.go、internal/web/model_dispatch_test.go。

## 6. Testing

- **TEST-001**: 同一自然语言多节点查询，模型不调用委派工具时无采样、无子任务、无自动 Beacon。
- **TEST-002**: 模型显式选择五个任务时真实并行，子模型首先收到工具目录并自行选择观察，Beacon 仅由模型调用产生。
- **TEST-003**: 只读集群命令不含写操作和原始凭据，固定参数拒绝注入，目标集群不匹配时拒绝继续读取状态。
- **TEST-004**: 已有工作流、权限、取消和目录测试继续通过；调试 Web 正常加载且工作流入口隐藏。

## 7. Risks & Assumptions

- **RISK-001**: 模型可能选择低效计划；提示与来源映射改善选择，不承诺一定委派或固定耗时。
- **ASSUMPTION-001**: 所选集群节点已安装 kubectl 并配置可用客户端；缺失时返回真实失败和能力缺口，不猜测其他集群。

## 8. Related Specifications / Further Reading

[子 Agent 设计](architecture-lake-multi-agent-1.md)
[被替代的固定巡检](feature-auto-node-survey-1.md)
