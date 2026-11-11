---
goal: SSH 首次连接在后台自动保存指纹并继续认证
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
owner: Codex
status: In progress
tags: [ssh, security, backend, ux]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户明确要求把首次 SSH 指纹弹窗改为默认在后台信任并连接。复用 LakeSSH 现有校验及原子私有信任文件，首次没有已存公钥时自动完成同一接受路径，不发布需用户确认的状态；已有公钥发生变化仍沿原确认协议。

## 1. Requirements & Constraints

- **REQ-001**: runtime/typescript/ssh.ts 的 authorize 对零个已存公钥的首次连接调用既有 decide 接受路径，在认证前持久化信任，不向界面发布首次确认弹窗。
- **REQ-002**: 已存公钥匹配继续直接连接，变化仍需准确指纹确认；拒绝、失效、权限、配置变化、取消及私有文件校验保持。
- **REQ-003**: Pilot、Worker、child、ACP 工具桥和远程终端共享 LakeSSH 行为，不新增 UI 开关或模型授权渠道。
- **SEC-001**: 这是用户明确选择的首次使用信任；不进行独立身份校验，不自动覆盖已有不同公钥，不将主机信任当业务操作授权。
- **SEC-002**: 测试仅使用本地虚构 SSH 服务器及私有临时 Home；不打印密钥、密码或本机认证内容。
- **CON-001**: 继续当前 develop 草稿 PR；本轮仅签名安装 Dev，不合并或操作生产。
- **CON-002**: 用户要求清除旧备份后，不再积累完整 Home/数据库备份；安装验证使用记录哈希，既有任务不重派。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 实现后台首次信任并验证共享链路。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 修改 runtime/typescript/ssh.ts authorize：先登记内部确认上下文并监听取消，零已存公钥时直接调用 decide；异常沿 finish 拒绝，只有公钥变化才发布 prompt，hostVerifier 丢弃取消后已失效的协议回调。 | Yes | 2026-11-11 |
| TASK-002 | 更新 runtime/typescript/server.test.cjs 首次信任场景与 Worker/终端用例；保留变化、取消、失效和操作权限测试，补充落盘失败与并发首次连接回归。依赖 TASK-001。 | Yes | 2026-11-11 |
| TASK-003 | 更新 agent.md、docs/security/task-confirmation.md、runtime/typescript/README.md，说明首次使用信任和已有公钥变化的不同处理；旧验证记录保持其原 SHA。依赖 TASK-001。 | Yes | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: 完成检查、Dev 安装及可评审交付。依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 运行 TypeScript 类型、全部后端单元、宿主集成、固定 Codex ACP、运行时边界和命名检查，记录准确结果。依赖 TASK-002。 | Yes | 2026-11-11 |
| TASK-005 | 干净提交后使用 scripts/build_lake_desktop.sh --dev --install，核对签名、来源、原任务及本机配置；安装前等待实际 Dev 空闲并正常退出。依赖 TASK-004。 | | |
| TASK-006 | 写入 docs/validation/acp-agent-execution/ssh-first-use-trust.md 及 JSON，更新兼容记录和现有草稿 PR，保留未合并状态。依赖 TASK-005。 | | |

## 3. Alternatives

- **ALT-001**: 由前端自动点击按钮：仍产生弹窗和等待，并使终端、后台 Worker 的行为分散，不采用。
- **ALT-002**: 关闭全部 hostVerifier：无法复用持久指纹及变化检测，不采用。
- **ALT-003**: 新建另一套信任存储或额外确认开关：不符合用户默认后台处理的要求，不采用。

## 4. Dependencies

- **DEP-001**: LakeSSH 原 decide、privateFile、atomic 和现有 known_hosts 格式。
- **DEP-002**: 原 SSH fixture、真实 ssh2 协议及规范任务账本。

## 5. Files

- **FILE-001**: runtime/typescript/ssh.ts。
- **FILE-002**: runtime/typescript/server.test.cjs，按需要增加 SSH 独立回归。
- **FILE-003**: agent.md、docs/security/task-confirmation.md、runtime/typescript/README.md、docs/validation/acp-agent-execution/。

## 6. Testing

- **TEST-001**: 首次真实 SSH 连接没有 HostKeyTrust 弹窗；先保存私有公钥，再认证和打开 PTY，重启复用且秘密不外泄。
- **TEST-002**: 公钥变化仍在认证前暂停，错误指纹/取消不覆盖；显式接受后新指纹生效。
- **TEST-003**: 无法保存信任、停止或配置变更时不继续认证；同一端点并发首次连接不互相覆盖。
- **TEST-004**: Worker/child/ACP 原任务和权限回归通过；签名 Dev 来源正确，旧账本及本机配置保持。

## 7. Risks & Assumptions

- **RISK-001**: 首次使用信任接受首次观察到的公钥，不证明首次连接前的服务端身份；这是本次用户明确要求的默认行为。
- **RISK-002**: 本轮不自动重放安装前已超时的连接或旧业务任务。
- **ASSUMPTION-001**: 当前分支适合继续原 PR，origin/develop 仍为其祖先；安装只涉及 Dev。

## 8. Related Specifications / Further Reading

- [架构职责](../agent.md)
- [操作与验收](../docs/security/task-confirmation.md)
- [Security 设计](../docs/design/lake-security-v1.md)
- [原 SSH 验证范围](../docs/validation/typescript-candidate/ssh-confirmation.md)
