---
goal: 修复多 Agent 预算误计和主机集群调查能力错配
version: 1
date_created: 2026-10-13
last_updated: 2026-10-13
status: Completed
tags: [bug, multi-agent, operations]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

预算按在途预留与实际模型用量结算；工具按职责和资源类型暴露。模型选择目标、步骤和复核时机。

## 1. Requirements & Constraints

- **REQ-001**: 每次模型请求原子预留，返回后按实际用量结算；未发出的请求不计费；未知用量保守计算。
- **REQ-002**: 已请求 Beacon 时保留复核额度；排队不消耗任务执行期限；不自动追加 Beacon。
- **REQ-003**: SSH 上 Deep 可读 Kubernetes 数据工作负载状态与日志；直接数据库指标只向数据库/Redis 资源暴露。
- **REQ-004**: Scout 支持限定目录的磁盘统计及已删除文件句柄；Scout/Trace 支持指定服务日志；Trace 可查 Kubernetes Pod 日志。
- **REQ-005**: Kubernetes 身份校验处理输出噪声，失败保留原始错误；日志选择器有界、参数转义、身份匹配。
- **REQ-006**: 累计用量随父会话 context 配置调整：每子任务 32K–64K，本轮 128K–256K；与单请求 context 分开。最后模型步骤或观察次数上限后关闭工具并要求有证据的简短报告。
- **REQ-007**: 区分数量上限与 token 额度，错误返回已用和上限；同轮累计最多 24 个任务，每批最多七调查加一验证，已结束任务后允许按剩余额度补派。
- **REQ-008**: 脱敏原始观察单独以私有文件保留，索引和明文分页仅允许当前会话当前轮登记 ID；旧预览缺失和源采集上限明确标记。默认预览同时限制 metadata 数量，压缩保留证据 ID 和游标。
- **REQ-009**: 压缩请求按实际序列化大小适配子任务 16K context，不固定占用 20K 字符。
- **SEC-001**: 不允许子 Agent 任意 Shell、SQL、修改、凭据读取或越权资源；保留父权限和取消；不推送。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 修复预算结算与执行期限。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/ai/agent_budget.go、multi_agent.go 实现请求预留、结算、等待释放和复核预留；执行时启动 deadline。 | Yes | 2026-10-13 |

### Implementation Phase 2

- **GOAL-002**: 补齐受控调查工具及能力描述。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-002 | multi_agent.go、catalog.go、directory_targets.go 按资源类型提供 childObservationTools 和 capability metadata。 | Yes | 2026-10-13 |
| TASK-003 | cluster_observations.go 新增有界 Pod 日志观察，保留身份校验的原始失败输出。 | Yes | 2026-10-13 |
| TASK-004 | agent_observations.go、host_observations.go、tools.go、permissions.go 添加 journal、磁盘目录统计、已删除文件句柄；禁止模型命令。 | Yes | 2026-10-13 |

### Implementation Phase 3

- **GOAL-003**: 验证实际用量和任务完整性。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | agent_budget_test.go 验证实际结算、未知用量、在途释放、取消、上限和七任务含 Beacon。依赖 TASK-001。 | Yes | 2026-10-13 |
| TASK-006 | 观察工具测试验证注入、范围、失败诊断、缺失文件及角色匹配；AI/Web race；签名构建；空闲时更新 Web。依赖 TASK-002–TASK-004。 | Yes | 2026-10-13 |

### Implementation Phase 4

- **GOAL-004**: 解决补派误报与原始证据不可读。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | 区分任务数与 token 预算，已结束批次可按余额补派；上限仍有界。 | Yes | 2026-10-13 |
| TASK-008 | agent_evidence.go 保存脱敏源、分页索引/明文、当前轮授权、旧数据兼容；压缩适配 16K。 | Yes | 2026-10-13 |
| TASK-009 | 195,765/256,000 场景补派、跨会话/跨轮拒绝、完整中文源重启后分页、私有权限及脱敏、源截断、16K 压缩回归；签名构建并空闲更新 Web。 | Yes | 2026-10-13 |

## 3. Alternatives

- **ALT-001**: 单纯提高硬额度会隐藏误计，不采用。先按实际 usage 结算；真实模型复测另证明六任务累计实际用量已达 123,373，需随父 context 调整累计额度并校准请求预估，保留有限上限。
- **ALT-002**: 子 Agent 开放任意 Shell 会绕过受控观察边界，不采用。

## 4. Dependencies

- **DEP-001**: 现有 Stream Usage、scopedChildConfig、父权限、SSH 信任和模型自主调度。

## 5. Files

- **FILE-001**: internal/ai/multi_agent.go、agent_budget.go、agent_budget_test.go、catalog.go、directory_targets.go。
- **FILE-002**: internal/ai/agent_observations.go、cluster_observations.go、host_observations.go、tools.go、permissions.go 和对应测试。

## 6. Testing

- **TEST-001**: 七个任务、多轮模型请求与实际输入输出计费测试，无生产写操作。
- **TEST-002**: 受控命令真实 POSIX/kubectl formatter fixture 测试；Go race 回归与签名校验。

## 7. Risks & Assumptions

- **RISK-001**: 已通过签名 CLI 在五台真实 SSH 节点验证 12 次只读观察，七任务完成；规划模型为脚本 fixture，4.628 秒不代表真实大模型调查性能。直接 Go 测试程序不支持 SSH_ASKPASS，不能作为生产连接失败证据。
- **RISK-002**: 真实配置大模型旧额度复测失败已保留。调整后新会话模型自行派发八任务，八任务全部完成（包括 Beacon），36 次观察成功、2 次观察失败并由报告说明限制；子任务阶段 140.8 秒。主模型随后请求补充终端取证，测试在审批处主动取消，未测得完整最终回复，不声称同范围加速。
- **RISK-003**: 用户本轮实际子任务 8 个，用量 195,765/256,000，拒绝来自旧的 8 任务数量上限。旧截断预览丢弃的明文无法恢复，必要补采仍由模型决定；本次不执行生产补采。
- **ASSUMPTION-001**: 服务端 usage 字段可信；缺失字段仍保守预留。

## 8. Related Specifications / Further Reading

[证据分页验证](../docs/validation/lake-agent-evidence-paging.json)

[验证记录](../docs/validation/lake-agent-investigation-reliability.json)

[自主调度](refactor-model-agent-dispatch-1.md)
[同轮压缩](refactor-context-turn-recovery-1.md)
