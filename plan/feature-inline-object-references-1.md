---
goal: Lake 回复中的行内对象引用与轻量排版
version: 1
date_created: 2026-10-22
last_updated: 2026-10-22
owner: Lake
status: 'In progress'
tags: [feature, frontend, conversation]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

在回复原句中把可识别的资源、软件组件、文件和已命名任务显示为轻量行内标签。沿用已确认的软件中性淡底色、资产复用现有类型标签、小图标、常规字重、无边框表格与完整正文，不增加标签栏、总结卡片或自动折叠。仅修改展示层，不改消息原文、模型请求或执行权限。

## 1. Requirements & Constraints

- **REQ-001**: `web-agent/web/src/objectReferences.ts` 使用当前会话项目资源的唯一名称、资源 ID 和完整主机地址绑定资源，歧义名称保持原文；禁止通过短 IP 后缀猜测资产。
- **REQ-002**: 软件名称与版本使用有限的确定性目录识别，包括 PostgreSQL、PostGIS、MySQL、Redis、Nginx、Docker、Kubernetes 等；软件标签不冒充实际资源实例。
- **REQ-003**: 文件引用使用明确路径或本轮文件变更记录，任务引用使用已存在的命名任务；未知对象不生成可执行跳转。
- **REQ-004**: Markdown 转换仅处理正文与完整匹配的行内代码对象；代码块、命令、链接、URL、HTML 和参数名保持原样；不修改持久消息。
- **REQ-005**: 普通回复、终端会话、SRE 正文、SRE 报告共用引用渲染；已有会话分类标签继续生效。
- **REQ-006**: 标签使用主题变量与 `Glyph`，常规字重、约 22px 行内高度、小圆角；长名称与窄窗口不撑宽正文；键盘可操作，浅深色一致。
- **REQ-007**: 实际资源点击仅展示当前快照的只读详情；软件显示类型说明；已记录文件可预览会话中保存的内容。点击标签不执行操作。
- **REQ-008**: 回复常规字重、表格无框线与表头底色、正文不自动折叠；操作记录、证据和审批沿用原有交互。
- **SEC-001**: 详情只显示名称、类型、主机、端口、用户名和文件路径等白名单字段，禁止序列化资源 settings 或凭据。
- **CON-001**: 保留工作区已有改动，不新增依赖，不读取 Keychain 或正式版数据；桌面联调仅使用签名的 Dev 构建。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 实现确定性的对象匹配和共享渲染。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新建 `web-agent/web/src/objectReferences.ts`，实现对象目录、最长匹配、歧义回退、边界检测和 Markdown AST 转换。 | ✅ | 2026-10-22 |
| TASK-002 | 新建 `web-agent/web/src/AssistantMarkdown.tsx` 和 `objectReferences.css`，实现共享 provider、行内标签、只读详情与文件预览；依赖 TASK-001。 | ✅ | 2026-10-22 |
| TASK-003 | 接入 `AIPanel.tsx`、`SREReport.tsx`、`AgentTaskList.tsx` 的正文/任务结果，传递当前项目资源和本轮文件记录；依赖 TASK-002。 | ✅ | 2026-10-22 |

### Implementation Phase 2

- **GOAL-002**: 应用已确认的排版并完成验证。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | 更新 `assistantProse.css` 和 `docs/ui-guidelines.md`：常规字重、无边框表格、正文完整展示，移除普通/SRE 正文自动折叠接入。 | ✅ | 2026-10-22 |
| TASK-005 | 新建 `web-agent/web/test/object-references.test.ts`，覆盖资源歧义、软件版本、文件/任务、代码与 URL 边界、历史/流式正文和共享 SRE 渲染。 | ✅ | 2026-10-22 |
| TASK-006 | 新建 `web-agent/web/test/fixtures/object-references.tsx` 与 HTML，验证浅深色、390px 窄窗口、标签详情、键盘关闭与无框线表格；类型检查、397 项前端测试和签名 Dev 构建通过。依赖 TASK-003、TASK-004、TASK-005。 | ✅ | 2026-10-22 |
| TASK-007 | 原工作区的 Dev 安装尝试被 `scripts/dev_build_origin.py` 的版本保护拦截；已保留现有应用。本 PR 从最新 `origin/develop` 适配，执行签名 Dev 包构建并在 PR 记录测试 HEAD；桌面安装联调仍待包含已安装来源提交的工作区完成。依赖 TASK-006。 | 未安装：版本保护 | 2026-10-22 |

## 3. Alternatives

- **ALT-001**: 让模型输出私有标签标记。首版不采用，避免依赖每个模型遵循新语法，也避免历史回复缺少标签。
- **ALT-002**: 将所有技术名词替换为彩色可点击标签。不采用，避免正文噪声和虚假资产关联。
- **ALT-003**: 将资源集中在回复顶部。不采用，用户已明确要求在原句出现的位置引用对象。

## 4. Dependencies

- **DEP-001**: 现有 React、react-markdown、remark-gfm 与 `Glyph`；不安装新依赖。
- **DEP-002**: `SessionSnapshot.resources`、本轮 `AICard` 文件变更和 `AgentRun` 已命名任务。
- **DEP-003**: 现有 `FilePreview` 与主题变量。

## 5. Files

- **FILE-001**: `web-agent/web/src/objectReferences.ts`，对象识别与 Markdown 装饰。
- **FILE-002**: `web-agent/web/src/AssistantMarkdown.tsx`、`objectReferences.css`，共享引用组件与交互。
- **FILE-003**: `web-agent/web/src/AIPanel.tsx`、`SREReport.tsx`、`AgentTaskList.tsx`，各类回复接入。
- **FILE-004**: `web-agent/web/src/assistantProse.css`、`docs/ui-guidelines.md`，视觉约定。
- **FILE-005**: `web-agent/web/test/object-references.test.ts` 与 `web-agent/web/test/fixtures/object-references.*`，回归和隔离预览。

## 6. Testing

- **TEST-001**: 唯一资源名称/IP 关联正确，同名、共用 IP、资源删除和未知名称回退正确。
- **TEST-002**: 软件名称与完整版本形成单个标签，不匹配参数子串、链接、URL、文件路径内部或 shell 命令。
- **TEST-003**: Markdown 原文、代码块、转义和链接目标不被改写，完整对象行内代码正确显示。
- **TEST-004**: 本轮文件/任务引用关联正确，未知文件不触发读取，同路径跨资源不错误绑定。
- **TEST-005**: 普通、SRE、终端共用效果；长回复完整展示；前端全量测试和类型检查通过。
- **TEST-006**: 浏览器实测浅深色与 390px 窄窗口无横向溢出，Enter 打开资源详情、Escape 关闭并恢复焦点，表格无边框、标签常规字重。

## 7. Risks & Assumptions

- **RISK-001**: 同名对象可能造成错误关联，使用唯一候选规则；软件标签仅表示文字中的软件类型和版本，不代表已验证部署状态。
- **RISK-002**: 流式输出到达完整版本前可能出现标签更新，保持原文不变与组件身份稳定，不显示加载动画或触发额外请求。
- **RISK-003**: 文件证据可能包含大量内容，仅使用已记录变更预览，不额外抓取文件或凭据。
- **ASSUMPTION-001**: 首版覆盖现有真实资源、有限软件目录、明确文件路径及已命名任务。数据库表与服务实例缺少可靠结构化 ID 时保持普通文本，后续由真实目录扩展，不猜测关联。

## 8. Related Specifications / Further Reading

- [Lake UI 规范](../docs/ui-guidelines.md)
- [本地开发规范](../CONTRIBUTING.md)
- [共享数据契约](../web-agent/shared/contracts.ts)
- [本次验证记录](../docs/validation/lake-inline-object-references.md)
