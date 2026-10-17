---
goal: 项目资源目录分级与拖动排序
version: 1.0
date_created: 2026-10-11
last_updated: 2026-10-11
owner: Lake
status: Completed
tags: [feature, navigation, sqlite]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

为项目资源添加可持久化目录树，支持目录创建、重命名、移除以及资源/目录拖动排序与移动层级。

## 1. Requirements & Constraints

- **REQ-001**: 在资源区创建根目录与子目录，拖动同项目节点排序或移入目录、移回根层。
- **REQ-002**: SQLite 保存层级与顺序，刷新、服务重启后复用；旧资源按原顺序迁移到根层。
- **REQ-003**: 移除目录将其子节点移到父层，不删除资源。
- **SEC-001**: 后端拒绝跨项目移动、资源作为父节点、目录循环及无效排序目标。
- **CON-001**: 目录仅用于导航，项目资源在所有会话中的引用与终端绑定保持有效。
- **CON-002**: macOS 仅使用 scripts/build_lake.sh 构建签名 bin/lake；不输出凭据。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 持久化目录与节点顺序。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | internal/web/schema.sql 新建 resourceTree 表；store.go 迁移种子及创建资源节点、Catalog 返回节点。 | ✅ | 2026-10-11 |
| TASK-002 | internal/web/resource_tree.go 事务实现目录创建/改名/移除和节点移动；server.go 增加项目 resource-tree API。 | ✅ | 2026-10-11 |

### Implementation Phase 2

- **GOAL-002**: 可操作的资源树与验证。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | contracts.ts/api.ts 接入 ResourceTreeNode；ResourceTree.tsx 渲染分级目录及拖动前/后/进入目标，App.tsx 复用原资源终端行。 | ✅ | 2026-10-11 |
| TASK-004 | styles.css 提供缩进、折叠、拖动反馈及触屏/键盘移动入口。 | ✅ | 2026-10-11 |
| TASK-005 | Go 验证迁移、跨项目/循环拒绝、排序、重启复用与目录移除保留资源；前端验证树排序与移动目标；隔离浏览器验证。 | ✅ | 2026-10-11 |
| TASK-006 | 签名构建，在生产无活动轮次时更新服务，保存验证记录。 | ✅ | 2026-10-11 |

## 3. Alternatives

- **ALT-001**: 仅用 localStorage 保存布局，因不能跨浏览器与后端恢复而不采用。
- **ALT-002**: 更改资源 ID 或会话资源引用，因目录不应改变目标身份而不采用。

## 4. Dependencies

- **DEP-001**: 现有 Go SQLite Store 事务及鉴权 API。
- **DEP-002**: 现有 React、原生拖放、资源终端控件；不新增运行时依赖。

## 5. Files

- **FILE-001**: internal/web/resource_tree.go、resource_tree_test.go、schema.sql、store.go、server.go。
- **FILE-002**: web-agent/shared/contracts.ts、web-agent/web/src/api.ts、ResourceTree.tsx、resource-tree-model.ts、App.tsx、styles.css。
- **FILE-003**: web-agent/web/test/resource-tree.test.ts 与 docs/validation/lake-resource-tree.*。

## 6. Testing

- **TEST-001**: 合成项目与资源验证完整 API、原子校验、迁移及重启保存。
- **TEST-002**: 前端排序/循环目标及既有引用、滚动、授权回归；TypeScript 检查。
- **TEST-003**: 隔离浏览器操作新建多级目录、拖入、排序、刷新保留，不连接真实主机或调用模型。

## 7. Risks & Assumptions

- **RISK-001**: 并发树编辑须在同一 SQLite 事务校验和写入，禁止产生循环。
- **ASSUMPTION-001**: 此需求范围为项目内资源区，不包括会话排序或跨项目转移。

## 8. Related Specifications / Further Reading

[会话与资源约定](../web-agent/README.md)
