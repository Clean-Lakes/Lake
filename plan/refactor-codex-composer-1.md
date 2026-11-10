---
goal: 仅保留 Codex 外部执行并统一专员聊天模型入口
version: 1
date_created: 2026-11-10
last_updated: 2026-11-10
owner: Lake
status: 'In progress'
tags: [refactor, acp, codex, composer, typescript]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

按用户四项修订移除 runtime-acp 外部后端，启用 Codex 时自动识别本机运行路径，专员新任务默认 Codex，将执行选择并入聊天框原模型菜单。原生 SDK 仍支撑 Lake 自身执行；历史 Task/Worker/Operation 保留原执行身份。

## 1. Requirements & Constraints

- **REQ-001**: 外部目录、设置、工具与新任务入口只接受 Codex；删除 runtime-acp 的启动器及私有模型代理。历史绑定不重写、不回退或重放。
- **REQ-002**: 启用 Codex 时自动识别本机受支持 Node/npm；在项目私有目录准备固定适配器并验证 ACP。正常设置不要求手填路径，保留高级覆盖。
- **REQ-003**: 未设置执行偏好的专员默认 Codex；新 Worker 冻结当时配置，已有任务保持原执行者。显式原生选择仍有效。
- **REQ-004**: 删除独立执行分配面板，Codex 与普通模型共用 ComposerModelSelect / AppSelect 及原生模型浮层。Codex 为当前专员默认选项，选择普通模型使用 Lake 原生执行。
- **REQ-005**: Codex 选择沿既有显式新任务接单与幂等机制发送；配置未就绪保留草稿并从模型菜单打开当前项目 Agent 设置，报告与验收仍取实际运行记录。
- **SEC-001**: 自动识别只检查宿主配置及标准安装路径，验证真实可执行文件版本，不执行 shell 配置、不读取生产凭据、不接受模型指定路径。
- **SEC-002**: 保留原审批、租约、取消、真实业务回执与未知操作账本；删除旧后端不删除历史证据。
- **CON-001**: TypeScript Dev 改造经现有 develop 草稿 PR；仅用签名脚本安装 Lake Dev，未经授权不合并或操作正式版。
- **GUD-001**: 模型菜单复用 AppSelect、ProviderIcon 与共享几何；验证原生与 Web 浮层、明暗、键盘和窄窗口。
- **PAT-001**: 使用原 Task/Worker/官方 SDK/ACP service；不增加模型循环或另一份验收状态。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成仅 Codex 的后端与自动准备。任务顺序执行。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 修改 shared/external-agents.ts 与 acp/catalog.ts，仅提供 Codex；删除 acp/runtime-server.ts、server.ts 对应标志和 service.ts 的私有模型 RPC，旧绑定明确拒绝执行。 | true | 2026-11-10 |
| TASK-002 | 新增 runtime/typescript/acp/runtime-paths.ts，识别并验证本机 Node/npm；registry.ts 持久化 npmPath；service.ts / server.ts 提供启用与自动准备，使用固定版本安装及原 ACP probe。依赖 TASK-001。 | true | 2026-11-10 |
| TASK-003 | superagent.ts 的专员默认值改为 Codex，newAssignment 冻结有效配置；setRoleExecution 保存选择并保留角色 CAS，历史 Worker 不修改。依赖 TASK-002。 | true | 2026-11-10 |

### Implementation Phase 2

- **GOAL-002**: 完成统一模型入口。依赖 Phase 1。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 新增 useSpecialistModel.ts，接入 App.tsx 的 Codex 默认选择、角色保存、就绪状态及显式新任务输入；删除 AgentAssignmentControl.tsx 和上方分配面板。 | true | 2026-11-10 |
| TASK-005 | ComposerModelSelect.tsx、nativeModelPanel.ts、NativeModelPanelPage.tsx 在原菜单中增加 Codex 分组/选项与设置入口，保持普通模型及原生浮层功能。 | true | 2026-11-10 |
| TASK-006 | ExternalAgentSettings.tsx 只显示 Codex，启用后自动准备路径，手工路径折叠到高级设置；专员默认列表显示有效 Codex 选择。 | true | 2026-11-10 |

### Implementation Phase 3

- **GOAL-003**: 完成验证与交付。依赖 Phase 1/2。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | 用 Codex ACP 协议进程夹具替换已移除后端的生命周期测试，保留桥接权限/停止/child/幂等/验收回归；真实固定 Codex 验证 Node 22 与 Node 24 路径。 | true | 2026-11-10 |
| TASK-008 | 前端覆盖默认 Codex、统一菜单、未就绪与普通模型切换；执行类型、构建、回归和边界检查，签名安装 Lake Dev 并验证实际界面。 | true | 2026-11-10 |
| TASK-009 | 更新 docs/lake-pilot.md、ACP 验证记录及草稿 PR #222，记录准确 tested SHA、已知限制与历史兼容行为。 | | |

## 3. Alternatives

- **ALT-001**: 只隐藏旧 Agent 卡片仍保留可调用后端不符合删除要求，因此同时删除生产启动路径和代理。
- **ALT-002**: 第二个执行下拉会继续占用输入区，采用现有模型选择器及原生浮层。

## 4. Dependencies

- **DEP-001**: 固定 Codex ACP adapter 2.2.2、Codex engine 0.160.1 及项目私有 MCP 桥。
- **DEP-002**: 原角色 CAS、显式 Task 分配去重与实际外部运行投影。

## 5. Files

- **FILE-001**: runtime/typescript/acp/{catalog,registry,runtime-paths,service,types}.ts、server.ts、superagent.ts、agent.ts。
- **FILE-002**: web-agent/shared/external-agents.ts、web-agent/web/src/{App,ComposerModelSelect,NativeModelPanelPage,ExternalAgentSettings}.tsx、nativeModelPanel.ts、useSpecialistModel.ts、externalAgents.css。
- **FILE-003**: runtime/typescript/server.test.cjs、acp.integration.test.cjs、test-fixtures/codex-acp.cjs、Web 模型菜单与分配测试。

## 6. Testing

- **TEST-001**: 旧后端不在目录、不能启用或执行，旧运行记录完整可读；新角色默认 Codex，旧 Worker 不改写。
- **TEST-002**: Node/npm 自动识别、缺失与无效路径、真实 Codex 在受支持版本下经宿主 Read 与 work_finish 执行；不使用真实模型凭据。
- **TEST-003**: 原权限审批、停止与未知状态、逻辑 child、报告聚合、CAS 与重复请求不重放。
- **TEST-004**: Web 与 macOS 原生模型菜单默认 Codex、配置跳转保留输入、普通模型切换、明暗与窄窗口；不再出现独立分配面板。

## 7. Risks & Assumptions

- **RISK-001**: GUI PATH 可能缺少包管理器路径，识别同时检查标准安装目录；未找到时准确报告并允许高级覆盖，不静默下载系统运行时。
- **RISK-002**: 安装或握手可能失败，保留配置状态及错误，不将连接测试或报告当作业务成功。
- **ASSUMPTION-001**: Codex 菜单沿用上一版显式分配新任务的语义；已有任务仍从准确任务入口继续，修改默认不切换旧任务。

## 8. Related Specifications / Further Reading

- [原分配实现](feature-specialist-agent-assignment-1.md)
- [ACP 兼容记录](../docs/validation/acp-agent-execution/compatibility.md)
- [前端规范](../docs/ui-guidelines.md)
- [架构所有权](../agent.md)
