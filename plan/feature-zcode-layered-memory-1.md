---
goal: 复用 ZCode 原生记忆并按 Lake 用户、项目、专员分层积累与读取
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake Runtime / Memory
status: 'Completed'
tags: [feature, zcode, memory, superagent]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

用户确认启用 ZCode 原生长期记忆并结合现有 Super-agent 分层模型。实施基线为 develop `624a49d5`。复用公开 AgentRuntime、原生 Memory 文件协议及原生提取；Lake 管理准确范围、来源、独立积累/使用开关、单写者、发布与撤回。任务独立上下文和原操作/验收账本不变，不修改 ZCode 上游源码，不启用旧 Go Memory 或退役 V2。

## 1. Requirements & Constraints

- **REQ-001**: 长期知识按用户、项目共享和稳定专员范围隔离；专员 key 由 storeID/projectID/RoleID 解析，改名保留、新建同名不继承。
- **REQ-002**: Pilot 使用用户及项目合格知识，Worker 使用本角色与项目合格知识；临时 child 仅继承父任务允许片段，无独立持久库。
- **REQ-003**: 使用公开 ZCode AgentRuntime 与 memory 配置处理受控来源，禁止新模型/工具循环、SDK 私有导入和上游修改。每范围同一发布者；原生写入先进入私有暂存，发布经过版本核验。
- **REQ-004**: 积累与使用独立；新 Home 默认关闭，明确开启只覆盖后续来源，不回扫历史。当前用户授权在 Dev 启用新链路，正式 Home 不变。
- **REQ-005**: 任务成功以原验收为准，unknown 不成为成功经验；动态状态带原时间与准确引用，不能替代当前资源查询。原始工具文字按不可信资料处理。
- **SEC-001**: 每次读取、模型派发、工具及发布重验范围、当前安全状态、来源、资源版本、设置及撤回版本；记忆不签发执行权限。
- **SEC-002**: 文件 IO 限定私有记忆目录并拒绝符号链接、任意路径及凭据；模型 Key/SSH 私钥不得进入文件、API 或日志。
- **SEC-003**: 更正、遗忘与角色删除先阻止旧读取和迟到发布，再清理依赖内容；保留原业务审计，不重放旧任务或记忆模型请求。
- **CON-001**: 仅修改 TS 候选与兼容前端入口；签名构建安装 Lake Dev，普通默认及正式版维持原后端，全量迁移门禁不放宽。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 分层身份、来源与发布协议有实际可测实现。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新增 runtime/zcode/memory.ts：LakeMemory 的 scope/settings、captureUser/captureTask、原生暂存与单范围发布、读取/更正/遗忘及来源重验；使用 LakeStore 持久元数据与不可变文件版本。 | ✅ | 2026-11-06 |
| TASK-002 | 在 runtime/zcode/agent.ts 通过公开 AgentRuntime 接入原生 Memory 处理器，并在 provider 请求前组装当前允许知识；临时 child 不写长期库。依赖 TASK-001。 | ✅ | 2026-11-06 |
| TASK-003 | 修改 runtime/zcode/superagent.ts 的真实用户来源、Worker 结果和角色删除接点，准确绑定 RoleID/Task/Operation；并发与停止不触发重放。依赖 TASK-002。 | ✅ | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: 用户能开启、查看、更正和遗忘三层记忆。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 在 runtime/zcode/server.ts 接入分层记忆 API 与正常退出，更新 web-agent/shared/contracts.ts；保持旧 Go 入口兼容。依赖 TASK-001。 | ✅ | 2026-11-06 |
| TASK-005 | 新增 NativeMemorySettings.tsx 并从 MemorySettings.tsx 按后端能力进入，复用 AppSelect/Glyph/主题几何；显示用户、项目、专员范围及积累/使用、来源、更正/遗忘。依赖 TASK-004。 | ✅ | 2026-11-06 |

### Implementation Phase 3

- **GOAL-003**: 原生记忆跨任务闭环与隔离恢复通过验证后交付。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | 新增 runtime/zcode/memory.test.ts 及真实 ZCode/本地模型集成测试：跨 Task 同 Role 召回、同名/跨项目隔离、child 回流、设置改变、遗忘迟到、重启不重派、unknown/秘密/路径拒绝。依赖 TASK-002 至 TASK-005。 | ✅ | 2026-11-06 |
| TASK-007 | 运行 TS 类型/构建、后端与前端回归、ADK 边界，签名 Dev 安装与原生明暗/窄窗检查，记录准确 SHA、合成与真实模型证据边界。依赖 TASK-006。 | ✅ | 2026-11-06 |
| TASK-008 | 更新 agent.md、runtime/zcode/README.md、现有 CM/FM 计划与验证记录；提交 develop PR，保留全量迁移未验收项。依赖 TASK-007。[PR #186](https://github.com/Clean-Lakes/Lake/pull/186) 已创建，未合并。 | ✅ | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: 对每个 Worker/child 直接启用同一工作区原生自动记忆。缺少角色隔离、来源与撤回发布约束，不采用。
- **ALT-002**: 继续另建 ADK 提取/整理执行器或直接模型循环。与用户选定 ZCode 引擎不符，不采用。

## 4. Dependencies

- **DEP-001**: 固定 ZCode v3.17.2 的公开 AgentRuntime、resolveProjectMemoryRoot、原生文件工具和会话存储。
- **DEP-002**: LakeStore、LakeSecurity、原 TaskLedger/Operation、稳定角色身份及现有设置 UI。
- **DEP-003**: 本次候选保留已安装 Dev 的 Pilot 调度修复 [PR #185](https://github.com/Clean-Lakes/Lake/pull/185)，依赖其 head `cb24a624`，不授权独立合并该 PR。记忆撤回同时覆盖该修复引入的 predecessor 摘要。

## 5. Files

- **FILE-001**: runtime/zcode/memory.ts、memory.test.ts、agent.ts、superagent.ts、server.ts：记忆及受控接点。
- **FILE-002**: web-agent/shared/contracts.ts、web-agent/web/src/NativeMemorySettings.tsx、MemorySettings.tsx 与 API/CSS：可用设置入口。
- **FILE-003**: agent.md、runtime/zcode/README.md、CM/FM 计划、docs/validation/zcode-layered-memory/：架构及验收。

## 6. Testing

- **TEST-001**: 经真实 AgentRuntime 的合成模型写入原生 MEMORY.md/知识文件，新 Task 同 Role 可以召回；不同项目/Role 与临时 child 不扩大范围。
- **TEST-002**: 关闭使用/积累、更正/遗忘、角色删除和权限/连接改变后，后续请求与迟到发布均不含失效内容。
- **TEST-003**: source 幂等、并发单写者、私有文件发布故障和重启中断不重复模型派发，不改变原任务账本。
- **TEST-004**: 原生设置浅/深主题、窄窗、键盘/焦点及来源/编辑/遗忘交互；未运行平台及真实模型质量明确列出。

## 7. Risks & Assumptions

- **RISK-001**: 上游原生 Main 成功不等于 Lake Task 验收，必须以宿主来源筛选与发布重验限制。
- **RISK-002**: 文件与 SQLite 无跨介质原子事务，先完整私有文件版本后提交唯一可读指针，失败版本不可读取。
- **ASSUMPTION-001**: 用户“改造吧”授权本次设计的实现和 Dev 验证；不授权正式发布或其他开放 PR 的合并。

## 8. Related Specifications / Further Reading

- [架构约定](../agent.md)
- [分层记忆总方案](architecture-context-role-memory-1.md)
- [文件记忆主计划](feature-agent-file-memory-1.md)
- [Security](../docs/design/lake-security-v1.md)
- [贡献流程](../CONTRIBUTING.md)
