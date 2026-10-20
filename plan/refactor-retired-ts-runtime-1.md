---
goal: 删除已被 Go ADK 取代的 TypeScript Agent 和 Node Web 后端源码及过期使用入口
version: 1
date_created: 2026-10-20
last_updated: 2026-10-20
owner: Lake
status: 'Completed'
tags: [refactor, cleanup, runtime, adk]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

当前签名构建只使用 Go 后端及 React 前端。删除未再参与产品调用的根目录 `agent/` 与 `legacy/web-agent/`，保留当前前端、Go ADK、许可归属、历史验收记录及用户数据。

## 1. Requirements & Constraints

- **REQ-001**: 删除旧 TS Agent、旧 Node Web 后端及各自的 UI、脚本、测试、配置和依赖锁文件；当前 `web-agent/web/` 与 `web-agent/shared/` 保留。
- **REQ-002**: 删除 `docs/lake-ts-agent-v0.0.1.md`、`docs/lake-ts-power-contract.md`、`docs/lake-ts-recovery.md`、`docs/lake-cli-compatibility.md` 中已无实现对应的操作指南。
- **SEC-001**: 不读取凭据、不操作用户 home 或本地旧安装包、不启动模型任务及资源命令。
- **CON-001**: 运行时继续使用 `internal/ai/adk_*.go` 与 `internal/agent/storage`；不得新增回退运行时。
- **GUD-001**: 保留旧第三方归属到 `docs/licenses/lake-ts-agent-THIRD-PARTY-NOTICES.md`，标记旧计划与验收记录为历史材料。
- **PAT-001**: 扩展 `scripts/check_adk_runtime_boundary.go` 的现有 retired-path 门禁，禁止两个旧源码根目录重新进入仓库。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 明确当前生产构建不依赖旧文件，并移除全部旧源码。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 检查 `scripts/build_lake.sh`、桌面构建脚本、CI 和 Go/前端导入，确认不使用 `agent/` 或 `legacy/web-agent/`。 | 是 | 2026-10-20 |
| TASK-002 | 依赖 TASK-001。移动旧第三方声明到 `docs/licenses/`，使用 Git 删除两个旧源码根目录与 REQ-002 的四份旧操作指南，清理 `.gitignore` 的旧 Agent 产物规则。 | 是 | 2026-10-20 |

### Implementation Phase 2

- **GOAL-002**: 当前文档及自动检查均阻止旧运行时被误用。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 依赖 TASK-002。更新 `web-agent/README.md`、`docs/third-party-notices.md`、`cmd/lake/main.go` 的 `help`，明确旧源码已删除、历史用户数据保留；旧计划标记 Deprecated，旧验收记录添加历史提示。 | 是 | 2026-10-20 |
| TASK-004 | 依赖 TASK-002。向 `scripts/check_adk_runtime_boundary.go` 的 retired-path 列表加入 `agent`、`legacy/web-agent`，保留原 AST/provider 检查。 | 是 | 2026-10-20 |

### Implementation Phase 3

- **GOAL-003**: 删除后当前构建与回归均通过，形成可审查 PR。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | 依赖 TASK-003、TASK-004。执行前端测试和类型检查、完整 Go race/vet、ADK 边界检查及 `scripts/build_lake.sh` 签名构建。 | 是 | 2026-10-20 |
| TASK-006 | 依赖 TASK-005。记录删除文件数与真实验证结果，检查变更范围与敏感信息，提交独立分支并向 master 创建 PR。 | 是 | 2026-10-20 |

## 3. Alternatives

- **ALT-001**: 仅归档旧源码；未选择，因为仍保留可被误调用的第二套 Agent 实现。
- **ALT-002**: 删除全部 TypeScript；未选择，因为当前 React 工作台与共享协议仍依赖 TypeScript。

## 4. Dependencies

- **DEP-001**: 现有 Go ADK、存储与 Web 服务实现，保持运行语义不变。
- **DEP-002**: Node 24.14、pnpm 10.33.4 继续仅作为当前前端构建工具；签名沿用现有本地身份。

## 5. Files

- **FILE-001**: `agent/`、`legacy/web-agent/`、四份旧使用指南与 `.gitignore`。
- **FILE-002**: `docs/licenses/lake-ts-agent-THIRD-PARTY-NOTICES.md`、`docs/third-party-notices.md`、`web-agent/README.md`、`cmd/lake/main.go`。
- **FILE-003**: `scripts/check_adk_runtime_boundary.go`、`plan/architecture-lake-ts-agent-v0.0.1.md`、`docs/validation/lake-ts-agent-v0.0.1.md`。
- **FILE-004**: `docs/validation/lake-retired-ts-runtime-removal.json`，保存真实检查结果和范围。

## 6. Testing

- **TEST-001**: `python3 scripts/check_adk_runtime_boundary.py` 通过；在隔离仓库副本中恢复旧根目录时应失败，不访问业务数据。
- **TEST-002**: `pnpm --dir web-agent test:frontend` 与 `pnpm --dir web-agent check` 通过。
- **TEST-003**: `go test -race ./...` 与 `go vet ./...` 通过，覆盖当前 CLI、存储、ADK 和 Web。
- **TEST-004**: `scripts/build_lake.sh` 成功生成签名二进制；仅运行其 `--help` 验证当前入口，不安装或重启客户端。

## 7. Risks & Assumptions

- **RISK-001**: 旧文档可能误导开发者使用不存在的 CLI；删除旧操作指南并明确历史计划的状态。
- **ASSUMPTION-001**: 当前构建入口与引用扫描证明旧根目录未被生产使用，历史源码可从 Git 历史找回。

## 8. Related Specifications / Further Reading

- [开发规范](../CONTRIBUTING.md)
- [当前 ADK 架构](../docs/experiments/adk-runtime.md)
- [当前工作台](../web-agent/README.md)
