---
goal: 明确多节点只读巡检默认启动并行 Scout
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Deprecated
tags: [feature, multi-agent, performance]
---
# Introduction

已由 [模型自主调度](refactor-model-agent-dispatch-1.md) 替代：自然语言聊天不再固定触发巡检或自动 Beacon。

![Status: Completed](https://img.shields.io/badge/status-Deprecated-red)

修复已选择集群节点但仍依赖主模型决定委派并串行检查的问题。服务器识别明确的多节点只读巡检后固定调度真实 Scout，先采集、独立验证，再交由 Lake 汇总或处理依赖集群 API 的后续调查。

## 1. Requirements & Constraints

- **REQ-001**: 通用模式、自动多 Agent、明确至少两个主机目标和只读巡检目标时自动委派；关闭多 Agent、单节点、变更任务和未明确资源不触发。
- **REQ-002**: “继续”沿用最近明确的只读目标与资源范围；成功完成且 60 秒内的同范围自动巡检可复用，刷新与失败检查采集新证据。
- **REQ-003**: 2–7 节点每节点一个 Scout；8–21 节点均衡分配最多 7 个 Scout，每个最多 3 节点；大于 21 明确要求缩小范围，不能静默遗漏节点。
- **REQ-004**: 固定状态观察先于子模型，最多 6 个观察并发、3 个子模型并发；每个子模型只汇总已采集数据，不再循环执行命令。
- **SEC-001**: 保留父资源/目录限制、禁用本机、SSH 主机密钥检查与审批；只有可信服务器入口可放宽普通委派的每批三个任务限制。
- **CON-001**: 每轮最多 8 子任务，预留 Beacon；观察 10 秒、子任务 120 秒及用量预算沿用现有约束。
- **CON-002**: kubelet 状态不能当作 Kubernetes Ready；Lake 对缺失数据或集群 API 做必要后续调查，不能反复采集已成功的主机基础指标。
- **PAT-001**: 复用真实 AgentRun、证据、独立上下文及既有紧凑任务列表；不推送。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 固定并行采集与真实模型汇总。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/auto_survey.go 实现可信多节点调度、固定观察前序、并发池和失败记录；types.go、turn_input.go、engine.go、multi_agent.go 接入，agent_observations.go 增加 status 指标。 | ✅ | 2026-10-12 |
| TASK-002 | internal/web/auto_survey.go 解析明确目标、继续和已完成巡检复用；agent.go 在 hostPrelude 之前做调度决策，默认避免串行预检查。依赖 TASK-001。 | ✅ | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: 验证默认行为与客户端。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 测试自动触发、否决条件、五任务真实并行、固定观察、独立验证、取消及失败、任务和资源上限；运行 race 和前端回归。依赖 TASK-001–TASK-002。 | ✅ | 2026-10-12 |
| TASK-004 | 浏览器展示五个真实 Scout 和 Beacon；签名构建、更新独立调试实例与本地 arm64 客户端，保留正在运行的会话。依赖 TASK-003。 | ✅ | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: 只加强系统提示；不能保证主模型调用委派工具，未采用。
- **ALT-002**: 允许子 Agent 任意 Shell；增加重复命令和变更风险，本次使用固定只读观察。

## 4. Dependencies

- **DEP-001**: 既有目录目标解析、独立子引擎、证据与原有权限。
- **DEP-002**: 既有 React AgentTaskList 与签名构建。

## 5. Files

- **FILE-001**: internal/ai/auto_survey.go、auto_survey_test.go、engine.go、turn_input.go、types.go、multi_agent.go、catalog.go、agent_observations.go。
- **FILE-002**: internal/web/auto_survey.go、auto_survey_test.go、agent.go。

## 6. Testing

- **TEST-001**: 五个 Scout 的独立请求与并发屏障，先采集后汇总，主模型不负责初始委派。
- **TEST-002**: 关闭、单节点、变更、目录歧义和越界资源不会触发自动执行；21 节点全覆盖与超过上限拒绝。
- **TEST-003**: 停止、审批、观察失败、缺失证据及独立 Beacon 验证不伪造成功；继续与缓存行为。
- **TEST-004**: 浏览器真实任务行、无脚本异常、签名及现有工作流回归。

## 7. Risks & Assumptions

- **RISK-001**: 多个模型请求有开销，速度受 SSH 和模型响应影响；通过固定采集与并发限制减少重复往返，不承诺固定耗时。
- **ASSUMPTION-001**: 本次仅自动路由主机指标和节点巡检；其他域继续按需委派。

## 8. Related Specifications / Further Reading

[子 Agent 设计](architecture-lake-multi-agent-1.md)
[目录目标解析](feature-directory-target-resolution-1.md)
