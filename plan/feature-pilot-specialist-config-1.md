---
goal: Pilot 自然语言更新专员配置与头像
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
owner: Codex
status: In progress
tags: [pilot, specialist, configuration, avatar]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Pilot 当前只能保存专员名称和职责，头像由 RoleID 自动分配。补齐可发现的 Lake 头像目录与局部配置更新，将明确的头像要求保存为角色配置，并在共享头像组件显示。

## 1. Requirements & Constraints

- **REQ-001**: runtime/typescript/superagent.ts 的 manage_specialist 创建仍要求 name/duties；更新只提交改动的 name、duties、avatar_id、execution，未提交字段保持。
- **REQ-002**: list_specialist_avatars 返回共享 100 项本地目录，可按中文名/英文 ID 查询；avatar_id=auto 清除显式选择，不接受 URL、任意 SVG 或未知 ID。
- **REQ-003**: 默认 Agent 仅支持当前 native/Codex，通过原 registry 校验，配置不发起登录或业务任务；新任务仍冻结有效执行绑定。
- **REQ-004**: SpecialistChannelInfo 提供 avatarId；App 使用当前项目角色头像 Provider，同一 RoleID 的侧栏、标题、任务与 Pilot 报告显示相同头像；无配置时保持原确定性分配。
- **SEC-001**: 管理仍要求准确已接纳人工 event/quote、当前项目 RoleID、expected_revision、幂等 part_key；未知字段、失效版本及非法头像不写入。
- **SEC-002**: 不从职责文本推断或迁移头像；不改写旧 Worker、操作、验收、MCP 权限或本机 Codex 配置。
- **CON-001**: 保留 Lake 图形、动作、配色、主题、圆角及稳定 DOM；不引入另一套头像或配置界面。
- **CON-002**: 继续当前 develop 草稿 PR，仅签名更新 Dev，不合并、不发布或改生产，不重建完整数据备份。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成共享目录、原管理协议与显示接入。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 将 web-agent/web/src/lakeAvatarCatalog.ts 的纯目录移到 web-agent/shared/specialist-avatars.ts，原文件重导出；保留顺序与类型。 | Yes | 2026-11-11 |
| TASK-002 | 扩展 runtime/typescript/superagent.ts 的 Role、channelView、listRoles、manage、routerEntries 与 super-prompts.ts，支持头像查询、局部配置和复用执行后端校验。依赖 TASK-001。 | Yes | 2026-11-11 |
| TASK-003 | 扩展 web-agent/shared/contracts.ts、SuperRoleAvatar.tsx、superAgentPresentation.ts 和 App.tsx，以当前项目准确角色配置驱动现有头像，保留默认外观。依赖 TASK-001。 | Yes | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: 验证持久化、隔离和显示后安装 Dev。依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 在 superagent-lifecycle.test.ts/server.test.cjs 覆盖局部更新、非法/过期/跨项目/来源/幂等、重启和旧快照保留；specialist-avatars.test.ts 覆盖同角色多处显示及默认兼容。依赖 TASK-002、TASK-003。 | Yes | 2026-11-11 |
| TASK-005 | 更新 docs/lake-pilot.md、docs/ui-guidelines.md、runtime/typescript/README.md；运行类型、前后端单元、宿主、ACP、边界/命名及明暗窄窗夹具验证。依赖 TASK-004。 | Yes | 2026-11-11 |
| TASK-006 | 从干净代码提交签名安装 Lake Dev，核对来源、实际页面及原业务记录/本机配置哈希，不向真实 Pilot 伪造测试用人工输入。依赖 TASK-005。 | | |
| TASK-007 | 写入 docs/validation/acp-agent-execution/pilot-specialist-config.md/json，更新兼容记录及原草稿 PR并推送，不合并。依赖 TASK-006。 | | |

## 3. Alternatives

- **ALT-001**: 在职责中写“河狸”并推断头像：混淆业务指令与显示配置，不采用。
- **ALT-002**: 修改 RoleID 以碰撞目标头像：破坏稳定角色、频道及任务身份，不采用。
- **ALT-003**: 只在侧栏传入头像：其他身份显示不一致，不采用。

## 4. Dependencies

- **DEP-001**: 原 manage_specialist、superRoleMutations、Role revision 与 SQLite 事务。
- **DEP-002**: 现有 Lake 100 项头像及 SuperRoleAvatar、当前项目 workspace 轮询/SSE。
- **DEP-003**: 既有角色执行默认值、registry、Worker 冻结绑定及 Dev 签名入口。

## 5. Files

- **FILE-001**: web-agent/shared/specialist-avatars.ts、contracts.ts；web/src/lakeAvatarCatalog.ts、SuperRoleAvatar.tsx、superAgentPresentation.ts、App.tsx。
- **FILE-002**: runtime/typescript/superagent.ts、super-prompts.ts、superagent-lifecycle.test.ts、server.test.cjs；web-agent/web/test/specialist-avatars.test.ts 及显示夹具。
- **FILE-003**: docs/lake-pilot.md、docs/ui-guidelines.md、runtime/typescript/README.md、docs/validation/acp-agent-execution/。

## 6. Testing

- **TEST-001**: 创建含头像；更新只含 avatar_id 保留 name/duties/execution；同 part 幂等、auto 恢复默认；未明示字段不删除。
- **TEST-002**: 非法 ID、未知配置、过期 revision、跨项目 RoleID 和非真实原文均拒绝且数据库无变更；已有 Worker 快照/任务/操作保持。
- **TEST-003**: 通过真实 SDK 的合成模型工具调用走目录、创建/更新、读回及重启，不使用实际外网模型或业务目标。
- **TEST-004**: 头像 Provider 下同一 RoleID 在导航、报告、任务详情一致；改名和无显式配置保持原分配，未知旧值安全回退。
- **TEST-005**: 明暗/窄窗实际显示头像切换、稳定节点和动效；签名 Dev 版本、记录保留和 max 配置哈希一致。

## 7. Risks & Assumptions

- **RISK-001**: 模型选择错误同名角色；保留准确 ID/revision 与目录查询，不按名称自动合并。
- **RISK-002**: 显示头像切换不表示旧任务职责或执行者改变；已有业务快照保留。
- **ASSUMPTION-001**: 本轮范围为截图中的专员配置，不包含服务凭据或全局安全策略的自然语言修改。

## 8. Related Specifications / Further Reading

- [长期专员管理](../docs/lake-pilot.md#长期专员管理)
- [架构约定](../agent.md)
- [UI 规范](../docs/ui-guidelines.md)
- [任务确认](../docs/security/task-confirmation.md)
