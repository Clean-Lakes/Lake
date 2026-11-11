---
goal: SSH 换钥也自动信任，专员页仅展示角色任务
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
owner: Codex
status: In progress
tags: [ssh, security, frontend, ux]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户进一步要求已有 SSH 指纹变化时也默认后台信任并连接，同时删除专员任务页的聊天输入及新建任务按钮。新策略取代上一轮仅自动首次信任的限制；专员任务由 Pilot 派发，页面保留角色任务及原详情和控制协议。

## 1. Requirements & Constraints

- **REQ-001**: runtime/typescript/ssh.ts authorize 对首次和不同已存公钥均沿原 decide 原子保存后认证，不发布指纹提示；connect 只优先已存算法，不排除默认支持的新算法。
- **REQ-002**: web-agent/web/src/App.tsx 在角色页不挂载 composer-dock；删除 SpecialistChannel、SpecialistTaskList 的 onNewTask 属性及按钮，清理相关样式，空态指向 Pilot 派单。
- **REQ-003**: 角色页不接收附件拖入或把资源写入隐藏草稿；Pilot 的输入、模型选择、附件和资源引用沿原路径；原任务详情中的问题、操作确认与停止继续可用。
- **SEC-001**: 用户明确选择换钥自动接受，不再通过人工指纹确认核对变化；仍记录实际公钥，不关闭 SSH 验证回调或放开凭据、资源版本、权限、取消和验收。
- **SEC-002**: 保存失败不能认证或覆盖旧记录，旧指纹不因自动更新变成当前有效证据；旧任务不改写或重放。
- **CON-001**: 保持 Lake 组件、头像、主题、圆角、筛选、未读与详情交互；不新增设置项或派单入口。
- **CON-002**: 复用当前 develop 草稿 PR；只签名安装 Dev，不合并或动生产，不重建已删除的完整数据备份。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 完成 SSH 与专员页面改动，两项互相独立。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | runtime/typescript/ssh.ts 取消 pins.length 对自动接受的限制；serverHostKey 使用 prepend 保留已存算法偏好和默认支持算法。 | Yes | 2026-11-11 |
| TASK-002 | App.tsx 移除角色 composer 及隐藏输入的引用/上传路径；SpecialistChannel.tsx、SpecialistTaskList.tsx 删除 onNewTask；specialistTaskList.css 清理对应样式，更新空态。 | Yes | 2026-11-11 |
| TASK-003 | server.test.cjs 用真实 loopback SSH 覆盖同算法换钥、RSA 到 Ed25519、认证前落盘、重启复用、旧证据失效及换钥保存失败；更新既有前端用例。依赖 TASK-001、TASK-002。 | Yes | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: 验证、安装及记录。依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 更新 agent.md、docs/security/task-confirmation.md、docs/ui-guidelines.md、runtime/typescript/README.md，明确当前换钥策略和专员只展示任务的入口。 | Yes | 2026-11-11 |
| TASK-005 | 运行前后端类型与完整测试、固定 Codex ACP、边界/命名和构建；使用真实 App 的虚构数据夹具验证明暗、窄窗、任务详情/确认、Pilot 输入、筛选和未读。依赖 TASK-003。 | Yes | 2026-11-11 |
| TASK-006 | 干净提交后签名构建安装 Dev，核对来源、签名、原记录/配置及实际页面，保留源码 SHA；不触发真实服务器或新业务任务。依赖 TASK-005。 | | |
| TASK-007 | 更新 docs/validation/acp-agent-execution/ 验证文档和兼容记录，更新原草稿 PR，保留未合并状态。依赖 TASK-006。 | | |

## 3. Alternatives

- **ALT-001**: 前端自动点击变化确认：仍存在弹窗和后台路径差异，不采用。
- **ALT-002**: hostVerifier 无条件返回 true 且不落盘：失去实际身份和原证据重验，不采用。
- **ALT-003**: 用 CSS 隐藏输入：仍挂载附件、发送与新建逻辑，不采用。

## 4. Dependencies

- **DEP-001**: LakeSSH 原私有 known_hosts、decide、ssh2 公开算法偏好接口。
- **DEP-002**: 当前专员任务列表、SpecialistTaskControls 与共享 Pilot 对话入口。
- **DEP-003**: ego-browser 与现有 specialist-task-list 全 App 虚构夹具。

## 5. Files

- **FILE-001**: runtime/typescript/ssh.ts、server.test.cjs。
- **FILE-002**: web-agent/web/src/App.tsx、SpecialistChannel.tsx、SpecialistTaskList.tsx、specialistTaskList.css；web-agent/web/test/specialist-task-list.test.ts。
- **FILE-003**: agent.md、docs/security/task-confirmation.md、docs/ui-guidelines.md、runtime/typescript/README.md、docs/validation/acp-agent-execution/。

## 6. Testing

- **TEST-001**: 真实 SSH 同算法和跨算法换钥不发布 prompt，保存后才认证；重启复用最新公钥，旧 peer 不通过 revalidate，失效人工决定不能覆盖新记录。
- **TEST-002**: 换钥落盘失败保留旧记录且零新增认证；首次、并发和取消回归保持。
- **TEST-003**: 专员页桌面与窄窗均无输入、新建或隐藏上传；筛选、搜索、已读、任务行/详情和业务确认仍正常。
- **TEST-004**: 返回 Pilot 后输入、模型与附件正常，原草稿不因浏览专员被清空；主题、焦点和页面布局实际验证。
- **TEST-005**: 签名 Dev 来源准确，旧任务/操作/验收与本机配置哈希一致；无真实业务操作或完整备份。

## 7. Risks & Assumptions

- **RISK-001**: 自动接受变化不再通过人工核对服务器换钥；这是用户明确选择的行为，连接成功不证明业务结果或旧身份连续性。
- **RISK-002**: 专员页不再提供直接派单，用户从 Pilot 继续；已有草稿及原任务数据不删除。
- **ASSUMPTION-001**: origin/develop 仍为当前既有功能分支祖先，PR 未获合并授权。

## 8. Related Specifications / Further Reading

- [架构](../agent.md)
- [任务合同](../docs/security/task-confirmation.md)
- [UI 规范](../docs/ui-guidelines.md)
- [上一轮首次信任](../docs/validation/acp-agent-execution/ssh-first-use-trust.md)
