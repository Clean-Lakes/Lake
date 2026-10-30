---
goal: 独立提供只读内置SOP清单与详情，不关联执行或授权
version: 1
date_created: 2026-10-30
last_updated: 2026-10-30
owner: Lake
status: Planned
tags: [feature, sop, ui, read-only, catalog]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

实施[内置SOP清单设计](../docs/design/builtin-sop-catalog-v1.md)，与[Lake Security后端计划](feature-lake-security-1.md)分开交付。当前仅编写设计，所有功能任务未开始；后续从最新origin/develop创建独立功能分支和PR，不把本计划视作功能合并授权。

## 1. Requirements & Constraints

- **REQ-001**: 工作区菜单提供独立“SOP”入口，专用列表/详情面板；浏览不依赖模型、项目或资源选择。
- **REQ-002**: 首批固定两条内置内容：service-diagnostics@1.0.0与data-sync-verification@1.0.0；展示用途、适用/前置条件、步骤/依赖、停止/失败处理及验收条件。
- **REQ-003**: 支持名称/摘要/分类搜索、分类筛选、列表选择和窄窗返回；显示内置来源、版本及流程实际影响。
- **REQ-004**: 内置内容随应用打包，只读API只提供列表/详情；不读取用户资源、聊天、凭据或外部网络。
- **SEC-001**: 浏览、搜索、选择、关闭不创建任务/工作流、不申请授权、不调用模型或执行命令；“内置”不代表执行许可。
- **SEC-002**: 不提供新增、编辑、删除、导入、发布、启停或运行按钮；后端不开放写入/执行路由，不能仅靠隐藏按钮控制。
- **SEC-003**: 内容是静态手册，参数仅描述不采集实际值；受限文本渲染，不启用原始HTML或脚本；内置目录ID不得作为文件路径。
- **CON-001**: 该功能是Security无UI改造约束之外的独立UI范围；不恢复新Security任务条/授权卡/风险看板，不开启隐藏的Workflows执行功能。
- **CON-002**: 遵守CONTRIBUTING和开发流程，普通PR目标develop，明确授权后才合并；macOS使用签名Lake Dev及隔离数据，不操作生产。
- **GUD-001**: 下拉使用AppSelect，图标使用Glyph，遵循共享曲线、主题、DisclosureSummary；验证浅深色、窄窗、键盘与焦点恢复。

## 2. Implementation Steps

每阶段依赖前一阶段退出条件；任务依赖单独列明。“否/未开始”是本次实际状态。

### Implementation Phase 1

- **GOAL-001**: 提供稳定、可验证、无运行能力的内置内容注册表。

依赖：无。退出条件：两条内容完整、ID/版本/依赖验证通过，包不依赖模型或执行器。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 新增 `internal/sop/catalog.go`，定义Summary/Detail/Step/Parameter类型和只读List/Get，使用go:embed加载builtin/*.json，验证source=builtin、ID/版本唯一、步骤依赖无环和必需字段，计算稳定catalogVersion。依赖：无。 | 否 | 未开始 |
| TASK-002 | 新增 `internal/sop/builtin/service-diagnostics.json` 与 `data-sync-verification.json`，按设计编写前置/停止/失败/验收；使用抽象资源参数，明确数据同步含写入和不可逆/人工处理边界，不放真实地址/命令执行器。依赖：TASK-001。 | 否 | 未开始 |
| TASK-003 | 新增 `internal/sop/catalog_test.go`，验证两条记录、版本稳定、未知ID/版本、损坏字段、依赖环、无真实资源数据；内容错误不可静默发布半份目录。依赖：TASK-002。 | 否 | 未开始 |

### Implementation Phase 2

- **GOAL-002**: 接入已认证的只读目录接口，证明无执行副作用。

依赖：GOAL-001。退出条件：GET列表/详情可用，写/执行路径拒绝，未认证拒绝，不查询模型/资源。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | 新增 `internal/web/sop_routes.go`，在 `server.go:ServeHTTP` 注册GET /api/sops及GET /api/sops/:id?version，沿用authorized/protect，返回目录版本和受限字段；未知ID404、版本不匹配明确提示，其他方法/执行子路径405或404，不进入bridge。依赖：TASK-003。 | 否 | 未开始 |
| TASK-005 | 在 `web-agent/shared/contracts.ts` 新增SopSummary/SopDetail只读类型，在 `web-agent/web/src/api.ts` 新增只读list/detail方法；不修改Security审批/AIView契约或加入运行方法。依赖：TASK-004。 | 否 | 未开始 |
| TASK-006 | 新增 `internal/web/sop_routes_test.go`，测试鉴权、稳定列表/详情、未知版本、写方法/执行路径拒绝；使用计数器证明无Engine/model/workflow/资源访问和持久化修改。依赖：TASK-004。 | 否 | 未开始 |

### Implementation Phase 3

- **GOAL-003**: 独立列表/详情UI满足纯浏览范围。

依赖：GOAL-002。退出条件：入口独立、只读浏览完整，未配置模型或项目时仍可读，关闭不改变会话运行。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-007 | 修改 `SidebarUtilities.tsx` 增加onSops回调及book图标“SOP”条目，`App.tsx`接独立打开状态；不切换会话/资源、不打开showWorkflows，关闭恢复可见工作区入口焦点。入口与设置同层，不受modelConfigured影响。依赖：TASK-005、TASK-006。 | 否 | 未开始 |
| TASK-008 | 新增 `web-agent/web/src/SopCatalog.tsx` 与 `sopCatalog.css`：搜索/分类、列表、详情、版本/内置来源/影响标识、loading/error/retry/empty；宽窗分区、窄窗单列返回。只GET目录，不提供写入/运行控件，复用AppSelect/Glyph/共享主题曲线。依赖：TASK-007。 | 否 | 未开始 |
| TASK-009 | 新增 `web-agent/web/test/sop-catalog.test.ts` 及隔离fixture，验证搜索/分类、详情选择、版本变化、失败重试、键盘/Escape/焦点，打开/关闭保留草稿与当前任务；断言请求只有目录GET且没有任务/授权/执行POST。依赖：TASK-008。 | 否 | 未开始 |

### Implementation Phase 4

- **GOAL-004**: 完成本地检查与Lake Dev只读联调，独立PR可供评审。

依赖：GOAL-003。退出条件：相关Go/前端检查及实际Dev验证有准确SHA，清单浏览零业务副作用。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-010 | 执行 `go test ./internal/sop ./internal/web`、`go test -race ./internal/sop ./internal/web`、`go vet ./internal/sop ./internal/web`，以及 `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend`、`pnpm --dir web-agent build:web`；处理相关失败，记录检查head。不触发未请求CI。依赖：TASK-009。 | 否 | 未开始 |
| TASK-011 | 用 `scripts/build_lake_desktop.sh --dev --install` 签名构建并在隔离Dev测试两条内容、无模型/无资源、窄窗/浅深色/键盘及长内容裁切；观察接口仅GET，草稿/任务/终端状态保持，记录SHA/Home/截图。依赖：TASK-010。 | 否 | 未开始 |
| TASK-012 | 新增 `docs/validation/builtin-sop-catalog-v1.md` 验证记录，更新本计划实际完成状态；创建独立SOP功能PR到develop，说明只读范围及回退，无用户授权不合并。依赖：TASK-011。 | 否 | 未开始 |

## 3. Alternatives

- **ALT-001**: 将SOP放进权限设置或打开现有隐藏Workflows。拒绝：清单浏览与权限/执行应独立，现有工作流还具有修改与运行入口。
- **ALT-002**: 第一版提供导入、编辑、运行。暂不采用：用户当前只要求展示内置SOP，新增写入和执行会扩大授权/维护范围。
- **ALT-003**: 从网页或模型动态生成清单。暂不采用：首期需要稳定版本、可审查的内置内容，避免展示内容随外部来源改变。

## 4. Dependencies

- **DEP-001**: [详细设计](../docs/design/builtin-sop-catalog-v1.md)定义条目、字段、只读API和首期边界。
- **DEP-002**: 现有工作区菜单、模态层、AppSelect/Glyph、api认证及UI主题；不依赖Lake Security功能已落地或模型服务可用。
- **DEP-003**: 当前go.mod、web-agent/package.json/锁文件和持久签名身份；按仓库工具链运行检查。

## 5. Files

- **FILE-001**: 新增 `internal/sop/catalog.go`、`builtin/*.json` 与catalog_test.go：独立内置内容包。
- **FILE-002**: 新增 `internal/web/sop_routes.go/sop_routes_test.go`，修改server.go注册只读路由。
- **FILE-003**: 新增 `web-agent/web/src/SopCatalog.tsx/sopCatalog.css`，修改SidebarUtilities.tsx/App.tsx接入独立入口。
- **FILE-004**: 修改shared/contracts.ts/api.ts仅添加目录读取类型/方法，新增sop-catalog.test.ts/隔离fixture。
- **FILE-005**: 更新本设计/计划及新增验证记录；Security方案仅加入独立功能引用，不放宽其无UI约束。

## 6. Testing

- **TEST-001**: 内容schema、ID/版本唯一、步骤依赖和两条内置条目完整性；数据同步的影响不能误标只读。
- **TEST-002**: HTTP鉴权、列表/详情/版本、未知路径、写方法与执行路径拒绝；无业务状态修改。
- **TEST-003**: 列表/详情/筛选/失败重试、无模型/无项目、键盘/焦点/窄窗与主题；请求记录只有目录GET。
- **TEST-004**: 执行TASK-010检查与TASK-011真实Dev验证，记录准确SHA及未验证项；模板测试不能冒充真实设备验收。
- **TEST-005**: 当前文档阶段仅校验结构/唯一ID/依赖/相对链接及git diff --check，不运行未来应用测试或声称UI已实现。

## 7. Risks & Assumptions

- **RISK-001**: 用户把“内置”误解成可直接运行；UI无运行入口，后端无执行接口，SOP详情说明适用性和授权独立性。
- **RISK-002**: 内置手册随环境老化；标版本与适用条件，通过普通代码评审和发布更新；本期不自动匹配生产环境。
- **RISK-003**: 清单只读容易与流程只读混淆；单独显示流程影响，数据同步明确包含写入。
- **ASSUMPTION-001**: 用户已确认本轮只纳入设计；后续实施独立PR，SOP清单与Security运行机制不捆绑交付。

## 8. Related Specifications / Further Reading

- [内置SOP清单设计](../docs/design/builtin-sop-catalog-v1.md)
- [Lake Security设计](../docs/design/lake-security-v1.md)
- [Lake Security后端计划](feature-lake-security-1.md)
- [贡献规范](../CONTRIBUTING.md)
- [开发流程](../docs/development-workflow.md)
- [UI规范](../docs/ui-guidelines.md)
