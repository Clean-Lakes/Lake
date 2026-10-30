---
goal: 独立提供只读内置SOP清单与详情，不关联执行或授权
version: 4
date_created: 2026-10-30
last_updated: 2026-10-30
owner: Lake
status: Planned
tags: [feature, sop, ui, read-only, catalog]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

实施[内置SOP清单设计](../docs/design/builtin-sop-catalog-v1.md)，与[Lake Security后端计划](feature-lake-security-1.md)分开交付。本轮已补齐[7份详细流程规范](../docs/design/builtin-sop-procedures-v1.md)，共49个步骤及逐项停止/失败/验收条件；当前仅编写设计，所有功能任务未开始；后续从最新origin/develop创建独立功能分支和PR，不把本计划视作功能合并授权。

## 1. Requirements & Constraints

- **REQ-001**: 工作区菜单提供独立“SOP”入口，专用列表/详情面板；浏览不依赖模型、项目或资源选择。
- **REQ-002**: 首批固定7条内置内容：6条专用SOP和general-task-fallback通用兜底，ID/版本按详细设计表；展示用途、适用/前置条件、步骤/依赖、停止/失败处理及验收条件。
- **REQ-003**: 支持名称/摘要/分类搜索、分类筛选、列表选择和窄窗返回；显示内置来源、版本及流程实际影响。
- **REQ-004**: 内置内容随应用打包，只读API只提供列表/详情；不读取用户资源、聊天、凭据或外部网络。
- **REQ-005**: 通用SOP规范澄清/取证/计划/授权/执行/验收或暂停，kind=fallback唯一。未来无适用专用SOP时走通用；目录错误/权限拒绝/未决副作用不能借兜底绕过。本期只展示该规则，不实现自动匹配/执行。
- **REQ-006**: 7条内置JSON严格映射详细流程规范的步骤/依赖/预期证据、停止与失败规则ID、验收ID与完成层级；诊断完成不等于恢复、条数相等不等于内容一致、重启退出成功不等于业务恢复。详情必须能完整浏览这些内容。
- **SEC-001**: 浏览、搜索、选择、关闭不创建任务/工作流、不申请授权、不调用模型或执行命令；“内置”不代表执行许可。
- **SEC-002**: 不提供新增、编辑、删除、导入、发布、启停或运行按钮；后端不开放写入/执行路由，不能仅靠隐藏按钮控制。
- **SEC-003**: 内容是静态手册，参数仅描述不采集实际值；受限文本渲染，不启用原始HTML或脚本；内置目录ID不得作为文件路径。
- **CON-001**: 该功能是Security无UI改造约束之外的独立UI范围；不恢复新Security任务条/授权卡/风险看板，不开启隐藏的Workflows执行功能。
- **CON-002**: 遵守CONTRIBUTING和开发流程，普通PR目标develop，明确授权后才合并；macOS使用签名Lake Dev及隔离数据，不操作生产。
- **GUD-001**: 下拉使用AppSelect，图标使用Glyph，遵循共享曲线、主题、DisclosureSummary；验证浅深色、窄窗、键盘与焦点恢复。

## 2. Implementation Steps

### 五模块交付对应

对应[五模块架构图](../docs/design/images/lake-security-five-modules.svg)。本计划19项任务的主责均为“SOP 手册”，任务正文统一标注【SOP 手册】。另外四块列为边界协作，不纳入本期执行功能，不改变独立交付约束。

| 模块 | 本计划对应 | 协作与验收边界 |
| --- | --- | --- |
| 任务中心 | 本期无运行接入任务 | SOP只描述目标/步骤模板，不创建WorkGoal；未来实例化另行评审 |
| SOP 手册 | TASK-001至TASK-019；第一阶段内容与注册表、第二阶段只读API、第三阶段工作区浏览、第四阶段检查与Dev验证 | 7份规范完整、版本一致、唯一兜底；19项分别交付静态内容/schema/API/UI/验证 |
| 安全控制 | 本期无授权/审批实现任务 | 沿用现有接口认证；手册与浏览不签grant、不放宽权限或解除unknown阻断 |
| 资源操作 | 本期无真实资源执行任务 | 测试请求只有目录GET，无命令、数据库、K8s、终端、workflow或模型调用 |
| 任务档案与验收 | 本期仅内容证据模板与功能验证记录 | 验证49步骤/规则/29验收绑定，记录测试SHA；不创建运行attempt/证据，不将手册内容当真实验收结果 |

4阶段共19项任务。每阶段依赖前一阶段退出条件；任务依赖单独列明。“否/未开始”是本次实际状态。

### Implementation Phase 1

- **GOAL-001**: 提供稳定、可验证、无运行能力的内置内容注册表。

依赖：无。退出条件：7条内容完整且通用兜底唯一、ID/版本/依赖验证通过，包不依赖模型或执行器。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | 【SOP 手册】新增 `internal/sop/catalog.go`，定义Summary/Detail/Step/Parameter类型和只读List/Get，使用go:embed加载builtin/*.json，验证source=builtin、kind=standard/fallback、ID/版本唯一及唯一general-task-fallback、步骤依赖无环、预期证据键及验收引用存在、停止/失败/验收ID唯一、completionLevel/required/预定义适用条件和必需字段，计算稳定catalogVersion。依赖：无。 | 否 | 未开始 |
| TASK-002 | 【SOP 手册】新增 `internal/sop/builtin/host-resource-diagnostics.json`（1.0.0），逐项落实详细规范第1节：H01–H07、停止/失败规则和H-A1–H-A4及证据引用；多点采样/平台口径/内存可用量/磁盘设备/脱敏进程，不自动清理或杀进程；单样本和缺指标不得宣称趋势。只提供静态手册内容，不实现运行器。依赖：TASK-001。 | 否 | 未开始 |
| TASK-003 | 【SOP 手册】新增 `internal/sop/builtin/service-diagnostics.json`（1.0.0），逐项落实详细规范第2节：S01–S07、停止/失败规则和S-A1–S-A4及证据引用；实例/监听占用/来源/TLS/健康/日志/依赖分层；禁止因TCP通就宣称业务恢复，探测越界停止。只提供静态手册内容，不实现运行器。依赖：TASK-001。 | 否 | 未开始 |
| TASK-004 | 【SOP 手册】新增 `internal/sop/builtin/database-health-check.json`（1.0.0），逐项落实详细规范第3节：D01–D07、停止/失败规则和D-A1–D-A4及证据引用；按driver/版本区分握手/认证/最小查询/实例/等待/应用池；无权限不等于健康，无证据不能归因连接池，不提权或写数据。只提供静态手册内容，不实现运行器。依赖：TASK-001。 | 否 | 未开始 |
| TASK-005 | 【SOP 手册】新增 `internal/sop/builtin/kubernetes-app-diagnostics.json`（1.0.0），逐项落实详细规范第4节：K01–K07、停止/失败规则和K-A1–K-A4及证据引用；同cluster/namespace/UID/版本的状态、事件、日志、Service/后端与节点证据；Running不等于Ready/业务恢复，exec和调试资源不隐含允许。只提供静态手册内容，不实现运行器。依赖：TASK-001。 | 否 | 未开始 |
| TASK-006 | 【SOP 手册】新增 `internal/sop/builtin/data-sync-verification.json`（1.0.0），逐项落实详细规范第5节：M01–M07、停止/失败规则和M-A1–M-A5及证据引用；源一致性manifest、目标基线/冲突策略、批次收据、键/类型化内容全量比较、原记录保护；unknown先对账，补偿需独占写入证明和另行授权，不全批盲重试。只提供静态手册内容，不实现运行器。依赖：TASK-001。 | 否 | 未开始 |
| TASK-007 | 【SOP 手册】新增 `internal/sop/builtin/service-restart-verification.json`（1.0.0），逐项落实详细规范第6节：R01–R07、停止/失败规则和R-A1–R-A4及证据引用；精确服务/配置/维护窗口、一次重启、实际句柄、恢复期限/稳定窗口和业务验证；unknown不重启第二次，不承诺自动回滚。只提供静态手册内容，不实现运行器。依赖：TASK-001。 | 否 | 未开始 |
| TASK-008 | 【SOP 手册】新增 `internal/sop/builtin/general-task-fallback.json`（1.0.0），逐项落实详细规范第7节：G01–G07、停止/失败规则和G-A1–G-A4及证据引用；未匹配专用时澄清/最小取证/版本化计划/授权/尝试/验收或暂停；信息不足不先写，权限拒绝或unknown不借兜底绕过。只提供静态手册内容，不实现运行器。依赖：TASK-001。 | 否 | 未开始 |
| TASK-009 | 【SOP 手册】新增 `internal/sop/testdata/procedure-coverage.json` 与内容审查记录规范，逐项对照49个步骤、预期证据/依赖、停止/失败/验收ID及完成层级；映射详细规范第8节7组正/反例作为内容与展示检查，确认没有命令、真实资源值或执行接口。依赖：TASK-002、TASK-003、TASK-004、TASK-005、TASK-006、TASK-007、TASK-008。 | 否 | 未开始 |
| TASK-010 | 【SOP 手册】新增 `internal/sop/catalog_test.go`，验证7条记录及唯一kind=fallback、版本稳定、未知ID/版本、损坏字段、依赖环、无真实资源数据、49个步骤与必要规则ID覆盖/证据引用无环、缺失任一停止/失败/验收内容必须拒绝；内容错误不可静默发布半份目录。依赖：TASK-009。 | 否 | 未开始 |

### Implementation Phase 2

- **GOAL-002**: 接入已认证的只读目录接口，证明无执行副作用。

依赖：GOAL-001。退出条件：GET列表/详情可用，写/执行路径拒绝，未认证拒绝，不查询模型/资源。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-011 | 【SOP 手册】新增 `internal/web/sop_routes.go`，在 `server.go:ServeHTTP` 注册GET /api/sops及GET /api/sops/:id?version，沿用authorized/protect，返回目录版本和受限字段；未知ID404、版本不匹配明确提示，其他方法/执行子路径405或404，不进入bridge。依赖：TASK-010。 | 否 | 未开始 |
| TASK-012 | 【SOP 手册】在 `web-agent/shared/contracts.ts` 新增SopSummary/SopDetail只读类型，在 `web-agent/web/src/api.ts` 新增只读list/detail方法；不修改Security审批/AIView契约或加入运行方法。依赖：TASK-011。 | 否 | 未开始 |
| TASK-013 | 【SOP 手册】新增 `internal/web/sop_routes_test.go`，测试鉴权、稳定列表/详情、未知版本、写方法/执行路径拒绝；使用计数器证明无Engine/model/workflow/资源访问和持久化修改。依赖：TASK-011。 | 否 | 未开始 |

### Implementation Phase 3

- **GOAL-003**: 独立列表/详情UI满足纯浏览范围。

依赖：GOAL-002。退出条件：入口独立、只读浏览完整，未配置模型或项目时仍可读，关闭不改变会话运行。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-014 | 【SOP 手册】修改 `SidebarUtilities.tsx` 增加onSops回调及book图标“SOP”条目，`App.tsx`接独立打开状态；不切换会话/资源、不打开showWorkflows，关闭恢复可见工作区入口焦点。入口与设置同层，不受modelConfigured影响。依赖：TASK-012、TASK-013。 | 否 | 未开始 |
| TASK-015 | 【SOP 手册】新增 `web-agent/web/src/SopCatalog.tsx` 与 `sopCatalog.css`：搜索/分类、列表、详情（参数/前置/步骤/停止/失败/逐项验收完整可读）、版本/内置来源/影响标识及通用兜底标识、loading/error/retry/empty；宽窗分区、窄窗单列返回。只GET目录，不提供写入/运行控件，复用AppSelect/Glyph/共享主题曲线。依赖：TASK-014。 | 否 | 未开始 |
| TASK-016 | 【SOP 手册】新增 `web-agent/web/test/sop-catalog.test.ts` 及隔离fixture，验证7条完整流程及49个步骤/规则的详情可读与通用标识、搜索/分类、详情选择、版本变化、失败重试、键盘/Escape/焦点，打开/关闭保留草稿与当前任务；断言请求只有目录GET且没有任务/授权/执行POST。依赖：TASK-015。 | 否 | 未开始 |

### Implementation Phase 4

- **GOAL-004**: 完成本地检查与Lake Dev只读联调，独立PR可供评审。

依赖：GOAL-003。退出条件：相关Go/前端检查及实际Dev验证有准确SHA，清单浏览零业务副作用。

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-017 | 【SOP 手册】执行 `go test ./internal/sop ./internal/web`、`go test -race ./internal/sop ./internal/web`、`go vet ./internal/sop ./internal/web`，以及 `pnpm --dir web-agent check`、`pnpm --dir web-agent test:frontend`、`pnpm --dir web-agent build:web`；处理相关失败，记录检查head。不触发未请求CI。依赖：TASK-016。 | 否 | 未开始 |
| TASK-018 | 【SOP 手册】用 `scripts/build_lake_desktop.sh --dev --install` 签名构建并在隔离Dev测试7条内容与通用兜底标识、无模型/无资源、窄窗/浅深色/键盘及长内容裁切；观察接口仅GET，草稿/任务/终端状态保持，记录SHA/Home/截图。依赖：TASK-017。 | 否 | 未开始 |
| TASK-019 | 【SOP 手册】新增 `docs/validation/builtin-sop-catalog-v1.md` 验证记录，更新本计划实际完成状态；创建独立SOP功能PR到develop，说明只读范围及回退，无用户授权不合并。依赖：TASK-018。 | 否 | 未开始 |

## 3. Alternatives

- **ALT-001**: 将SOP放进权限设置或打开现有隐藏Workflows。拒绝：清单浏览与权限/执行应独立，现有工作流还具有修改与运行入口。
- **ALT-002**: 第一版提供导入、编辑、运行。暂不采用：用户当前只要求展示内置SOP，新增写入和执行会扩大授权/维护范围。
- **ALT-003**: 从网页或模型动态生成清单。暂不采用：首期需要稳定版本、可审查的内置内容，避免展示内容随外部来源改变。

## 4. Dependencies

- **DEP-001**: [详细设计](../docs/design/builtin-sop-catalog-v1.md)定义条目、字段、只读API和首期边界。
- **DEP-002**: 现有工作区菜单、模态层、AppSelect/Glyph、api认证及UI主题；不依赖Lake Security功能已落地或模型服务可用。
- **DEP-003**: 当前go.mod、web-agent/package.json/锁文件和持久签名身份；按仓库工具链运行检查。

## 5. Files

- **FILE-001**: 新增 `internal/sop/catalog.go`、`builtin/*.json` 与catalog_test.go：独立内置内容包；`testdata/procedure-coverage.json`保存详细规则覆盖fixture。
- **FILE-002**: 新增 `internal/web/sop_routes.go/sop_routes_test.go`，修改server.go注册只读路由。
- **FILE-003**: 新增 `web-agent/web/src/SopCatalog.tsx/sopCatalog.css`，修改SidebarUtilities.tsx/App.tsx接入独立入口。
- **FILE-004**: 修改shared/contracts.ts/api.ts仅添加目录读取类型/方法，新增sop-catalog.test.ts/隔离fixture。
- **FILE-005**: 以 `docs/design/builtin-sop-procedures-v1.md` 为内容基准，更新本设计/计划及新增验证记录；Security方案仅加入独立功能引用，不放宽其无UI约束。

## 6. Testing

- **TEST-001**: 内容schema、ID/版本唯一、步骤依赖和7条内置条目、唯一通用兜底及其停止/验收条件完整性；数据同步的影响不能误标只读。
- **TEST-002**: HTTP鉴权、列表/详情/版本、未知路径、写方法与执行路径拒绝；无业务状态修改。
- **TEST-003**: 列表/详情/筛选/失败重试、无模型/无项目、键盘/焦点/窄窗与主题；请求记录只有目录GET。
- **TEST-004**: 执行TASK-017检查与TASK-018真实Dev验证，记录准确SHA及未验证项；模板测试不能冒充真实设备验收。
- **TEST-005**: 当前文档阶段仅校验结构/唯一ID/依赖/相对链接及git diff --check，不运行未来应用测试或声称UI已实现。
- **TEST-006**: 检查7份内容与详细规范的49步骤/依赖、各STOP/FAIL/验收ID及证据引用/完成层级一致；删除必需规则、悬空依赖/证据、以验收结果自证通过均拒绝。第8节反例只作为手册/schema/展示规范验证，不声称首期实现SOP执行安全引擎。

## 7. Risks & Assumptions

- **RISK-001**: 用户把“内置”误解成可直接运行；UI无运行入口，后端无执行接口，SOP详情说明适用性和授权独立性。
- **RISK-002**: 内置手册随环境老化；标版本与适用条件，通过普通代码评审和发布更新；本期不自动匹配生产环境。
- **RISK-003**: 清单只读容易与流程只读混淆；单独显示流程影响，数据同步明确包含写入。
- **ASSUMPTION-001**: 用户已确认本轮只纳入设计；后续实施独立PR，SOP清单与Security运行机制不捆绑交付。

## 8. Related Specifications / Further Reading

- [7份内置SOP详细流程](../docs/design/builtin-sop-procedures-v1.md)
- [内置SOP清单设计](../docs/design/builtin-sop-catalog-v1.md)
- [Lake Security设计](../docs/design/lake-security-v1.md)
- [Lake Security后端计划](feature-lake-security-1.md)
- [贡献规范](../CONTRIBUTING.md)
- [开发流程](../docs/development-workflow.md)
- [UI规范](../docs/ui-guidelines.md)
