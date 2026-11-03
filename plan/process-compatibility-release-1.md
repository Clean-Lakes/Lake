---
goal: 准备 Lake v0.3.25 macOS 迁移收尾兼容发布并明确后续授权门禁
version: 1
date_created: 2026-11-03
last_updated: 2026-11-03
owner: Lake maintainers
status: In progress
tags: [release, compatibility, security, macos]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

用户于2026-11-03授权“准备兼容性发布”，明确不包含直接合并、安装或重启生产。本计划交付版本文件、累计变更说明、兼容回归、验证记录和普通develop PR；真正发布须在候选冻结与后续明确授权后执行。生产旧Lake.app 0.3.24不支持已经收尾的format2清单，原归档已删除，不能通过降低校验恢复旧程序。

## 1. Requirements & Constraints

- **REQ-001**: `VERSION`准备为0.3.25；仅准备macOS arm64发布说明，Windows仍无新包，不改其0.3.22说明。
- **REQ-002**: 支持format1旧迁移和format2收尾凭据；启动校验storeID、epoch、原操作身份及canonical receipt，缺失或篡改仍拒绝。
- **SEC-001**: 保留当前数据库、凭据、原操作/证据/验收与unknown结果；禁止伪造清单/归档、手改gate、覆盖旧库或重放旧调用。
- **CON-001**: 准备分支从`origin/develop`的`2b233a4ad9d405e5b7bf4705359303b31bcde652`建立，普通PR目标develop。通过本分支merge commit保留`origin/master`的`b921d078044ef5cc0616970a4726fc15039e413e`生产历史；不得squash这次历史回同步。
- **CON-002**: 当前授权只允许准备。不得合并PR、创建develop→master生产PR、发布标签/Release、执行发布脚本、安装或重启生产。
- **CON-003**: PR #142的长期频道和后续执行/UI修复尚未进入develop；#143的标题修复与其有重叠。发布前须明确合入范围并解决重叠，不能把已安装Dev的验证当作当前develop候选验证。
- **GUD-001**: 兼容实现`c42c96f2`已经在develop。本次准备不复制另一套reader、不回退日常Dev、不新增自动删除备份行为。
- **PAT-001**: 后续最终候选定义为获准合入全部选定PR后执行`git rev-parse origin/develop`所得完整SHA；候选变化后重新验证，不使用本计划中的基线SHA代替最终SHA。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 明确来源、差异和授权边界，无生产变更。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 核对授权账号、origin refs、v0.3.24 Release及v0.3.25标签未占用，记录已合入和未合入范围。 | ✅ | 2026-11-03 |
| TASK-002 | 从指定develop基线建立`sync/v0.3.25-preparation`，仅在短分支merge指定master历史，验证合并后文件树不变。 | ✅ | 2026-11-03 |

### Implementation Phase 2

- **GOAL-002**: 交付可审阅的兼容性发布准备包。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 更新`VERSION`与`client/macos/RELEASE_NOTES.md`，说明format2、累计已合入变更、平台及兼容回退边界。 | ✅ | 2026-11-03 |
| TASK-004 | 在隔离测试目录运行finalization/recovery/risk回归及ADK边界；记录实际SHA和结果，不访问生产Home或复制秘密。 | ✅ | 2026-11-03 |
| TASK-005 | 使用`scripts/build_lake_desktop.sh --dev`制作带0.3.25版本的未安装签名Dev验证包，核对包版本、构建来源与严格签名；不覆盖日常Dev或生产安装。 | ✅ | 2026-11-03 |
| TASK-006 | 更新`docs/validation/lake-v0325-preparation.md`与JSON，检查计划格式、链接及diff；提交准备PR到develop并明确需merge commit保留生产历史。 | | |

### Implementation Phase 3

- **GOAL-003**: 在本次准备之外，取得对应授权后完成正式候选与发布。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | 仅取得用户对准确PR/head的合并授权后合入准备PR及选定修复；保留开放PR和被worktree占用分支，核对develop/master祖先关系及最终范围。 | | |
| TASK-008 | 冻结最终develop SHA，重跑全量Go、相关race/vet/边界、前端类型/测试/构建及签名Lake Dev验证；覆盖archive已删除的format2启动与unknown防重，记录未验证项。 | | |
| TASK-009 | 仅取得生产PR创建授权后创建同仓库develop→master PR；完成必需CI、至少一名合格独立评审和对应生产合并授权后，以merge commit合入。 | | |
| TASK-010 | 仅取得发布及生产安装/重启授权后，从干净origin/master签名构建正式包并校验SHA/版本/证书；发布以master为target，安装并核实真实生产就绪及原记录保留。 | | |

## 3. Alternatives

- **ALT-001**: 直接把当前工作分支安装生产：拒绝，绕过develop→master与单独生产授权，且包含未合入功能。
- **ALT-002**: 将format2改回format1、补一个不同SHA的归档或跳过校验：拒绝，会破坏安全历史及reader协议。
- **ALT-003**: 从master另开直接热修复PR：当前规范不允许普通分支指向master；未取得维护者明确隔离方案授权，不采用。

## 4. Dependencies

- **DEP-001**: develop已有format2 reader及回归，源提交`c42c96f289874771cd9f77786d5418ccdbefc45f`。
- **DEP-002**: PR #142及#143的发布范围、评审、重叠处理与准确head授权；本次准备不代为合并。
- **DEP-003**: 持久`Lake Local Development Code Signing`身份、Node24.14.0、pnpm10.33.4、Go1.26.6及macOS arm64构建环境。

## 5. Files

- **FILE-001**: `VERSION`与`client/macos/RELEASE_NOTES.md`：下一版本及macOS用户说明。
- **FILE-002**: `docs/validation/lake-v0325-preparation.md`及同名JSON：准备证据与未完成的发布门禁。
- **FILE-003**: 本计划：来源、原子任务、依赖与禁止事项。

## 6. Testing

- **TEST-001**: 现有`TestSecurityFinalize*`、`TestSecurityFinalized*`与风险/迁移/恢复测试验证无归档启动、篡改拒绝、三阶段中断与旧unknown防重；不新增镜像测试。
- **TEST-002**: 签名Dev验证包的backend `--version`、Info.plist、build-origin、ZIP/DMG SHA及`codesign --verify --deep --strict`一致为0.3.25；本次不安装该包。
- **TEST-003**: 计划front matter、必需标题、唯一声明ID、Markdown相对链接和`git diff --check`全部通过。
- **TEST-004**: 生产候选全量验证与真实生产升级仅属于后续已授权操作；当前状态必须保留not_run，不能冒充已修复生产。

## 7. Risks & Assumptions

- **RISK-001**: develop相对v0.3.24包含Security与Super-agent累计变更，不是单文件热补丁；未处理已知后续修复前不能宣布release-ready。
- **RISK-002**: 已删除的历史归档没有原字节恢复路径；旧0.3.24程序不是安全回退，必须保留兼容reader向前修复。
- **RISK-003**: 日常Dev已安装更靠后的功能分支。准备基线的非安装Dev包仅供隔离验证，不能绕过构建来源保护覆盖日常Dev。
- **ASSUMPTION-001**: 当前user授权只覆盖发布准备；下一步授权以用户后续明确指令为准，经过时间不构成授权。

## 8. Related Specifications / Further Reading

- [贡献规则](../CONTRIBUTING.md)
- [发布规范](../docs/development-workflow.md)
- [迁移收尾验证](../docs/validation/lake-security-migration-finalization.md)
- [本次准备验证](../docs/validation/lake-v0325-preparation.md)
- [macOS客户端](../client/macos/README.md)
