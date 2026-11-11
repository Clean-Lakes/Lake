---
goal: 让原生与 ACP Agent 按 Lake 资源目录发现准确的主机
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
owner: Codex
status: In progress
tags: [backend, assets, acp, bug]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

用户要求调查 Codex 为何将集群检查指向 Jenkins。已只读核对真实调用：目录名查询为空，IP 查询返回另一目录的 Jenkins；list_assets 只包含资源名/ID，未提供资源树路径。本计划修复共享的元数据检索，不重试旧任务或服务器。

## 1. Requirements & Constraints

- **REQ-001**: runtime/typescript/assets.ts 的 listProjectAssets 接收 resourceTree，返回按同项目真实祖先拼接的 path，并支持目录名及完整路径查询。
- **REQ-002**: 保留精确 asset_ref、配置 revision/pin、稳定 ID 分页与 8192 字节上限；路径最长为 JSON 编码后 2048 字节，截断明确标记。
- **REQ-003**: 相关目录改名/移动使旧游标失效；断链、循环或重复路径不猜测归属，明确 path_state=unavailable。
- **SEC-001**: 目录是元数据，不签发权限；保留原 Task/子执行/项目范围，不能泄露其他项目、兄弟受限资源或凭据，也不按共享 IP 合并资源。
- **SEC-002**: 原 unknown、审批和验收不改写，不重放既有调用；验证使用虚构资产与隔离 Home，不操作真实服务器。
- **CON-001**: 复用当前主题分支与 develop 草稿 PR；只安装签名 Lake Dev，生产环境不变。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 交付共用的有目录信息的资源查询。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | assets.ts 解析当前项目目录链，新增有界 path/pathTruncated/path_state，搜索完整路径并纳入分页目录摘要。 | ✅ | 2026-11-11 |
| TASK-002 | superagent.ts 的 list_assets 从同一 catalog 获取资源与目录，保留 targetResourceIds 过滤；描述要求按目录确认环境，禁止将共享入口 IP 当作相同目标。依赖 TASK-001。 | ✅ | 2026-11-11 |
| TASK-003 | assets.test.ts 验证目录查询、同名/同入口区分、游标变化、页预算、损坏树与范围隔离；acp.integration.test.cjs 让固定真实 Codex 经 Lake 桥查询虚构目录。依赖 TASK-002。 | ✅ | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: 验证实际宿主接入并安装 Dev。依赖 GOAL-001。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 运行后端类型、资产及全套后端单元、server.test.cjs、固定 Codex ACP 集成和边界/命名检查；每项记录准确结果及来源。 | ✅ | 2026-11-11 |
| TASK-005 | 干净提交经 scripts/build_lake_desktop.sh --dev --install 安装；只读核对目录查询的真实配置投影，比较旧 Worker/运行记录，保存 tested SHA。依赖 TASK-004。 | | |
| TASK-006 | 更新 agent.md、runtime/typescript/README.md、验证记录与原 develop 草稿 PR，记录未验证及回退，保持未合并。依赖 TASK-005。 | | |

## 3. Alternatives

- **ALT-001**: 仅给 Codex 追加硬编码目录或 IP 提示：掩盖共享目录缺失，且不能覆盖原生 Worker 与子 Agent。
- **ALT-002**: 按用户自然语言自动修改 Task 硬资源范围：本轮没有引入目录授权解析器，不将检索匹配升级为权限。

## 4. Dependencies

- **DEP-001**: LakeStore.catalog().resourceTree 为现有 Items 目录来源；资源归档/项目过滤继续由原 catalog 负责。
- **DEP-002**: 固定 Codex adapter 2.2.2、engine 0.160.1 的本地 Responses fixture 与 Lake MCP 桥；无真实模型凭据或外网推理。

## 5. Files

- **FILE-001**: runtime/typescript/assets.ts、superagent.ts：元数据与工具接入。
- **FILE-002**: runtime/typescript/assets.test.ts、acp.integration.test.cjs：精确发现、隔离与实际协议回归。
- **FILE-003**: agent.md、runtime/typescript/README.md、docs/validation/acp-agent-execution/：职责及验收记录。

## 6. Testing

- **TEST-001**: 目录名查询返回目录内的真实 ID；同名资源与同 SSH 入口的不同端口保持独立。
- **TEST-002**: 目录改名/移动拒绝旧 cursor，分页不丢 ID；路径和特殊字符不突破页预算或拆坏 Unicode。
- **TEST-003**: 外项目、损坏祖先、重复叶、被过滤资源均不泄露或错误归属，回调只访问本次可见结果。
- **TEST-004**: 真实固定 Codex 的 list_assets 结果包含准确路径、排除另一目录，随后原 Read/work_finish 正常取得回执和验收。
- **TEST-005**: 签名 Dev 原生任务页正常；全部旧 Worker 与运行状态保留，不再派发旧服务器任务。

## 7. Risks & Assumptions

- **RISK-001**: 完整路径增大响应；严格编码字节预算与明确截断，不放宽现有页限制。
- **RISK-002**: 改进目录发现不能保证模型永不选错目标；宿主继续独立验证准确资源与执行权限。
- **ASSUMPTION-001**: 源目录是显示元数据，不代表集群健康、Kubernetes 入口或任务授权已确认。

## 8. Related Specifications / Further Reading

- [贡献流程](../CONTRIBUTING.md)
- [开发约定](../docs/development-workflow.md)
- [三模块职责](../agent.md)
- [Items 与安全身份](../docs/design/items-security-memory-integration.md)
- [ACP 验证记录](../docs/validation/acp-agent-execution/compatibility.md)
