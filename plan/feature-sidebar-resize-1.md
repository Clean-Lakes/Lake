---
goal: 让桌面侧栏分界线可以拖拽调节宽度并保留用户设置
version: 1.0
date_created: 2026-10-01
last_updated: 2026-10-01
owner: Lake
status: 'Completed'
tags: [feature, desktop, ui]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

桌面侧栏目前固定为 220px，长会话和工作流名称被截断。为用户标出的侧栏右边界增加 Pointer Events 拖拽手柄，保存宽度并让正文继续使用现有列宽与对齐规则。

## 1. Requirements & Constraints

- **REQ-001**: 拖动侧栏右边界实时改变宽度，支持跨出手柄区域后继续拖动。
- **REQ-002**: 默认 220px，最小 180px，最大 480px；可用空间足够时为主区域保留至少 360px。缩窄窗口只限制显示宽度，不覆盖用户原偏好。
- **REQ-003**: 松开手柄后通过 localStorage 键 lake.sidebar-width 保存偏好；存储不可用或数据异常时仍可调整。
- **REQ-004**: 双击恢复默认；分界线可以键盘聚焦，左右键调整 10px，Shift 左右键调整 50px，Home/End 调到当前上下限；Escape 取消正在进行的拖动。
- **SEC-001**: 不更改会话、执行或凭据数据，不触发模型调用或远程命令。
- **CON-001**: 使用现有 React 和 DOM Pointer Events，不增加依赖；签名构建和安装沿用 scripts/build_lake_desktop.sh。

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: 侧栏具有可访问的拖动边界与可靠的偏好恢复。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | 新建 client/desktop/frontend/src/ResizableSidebar.tsx：封装 aside、separator、指针捕获、边界限制、窗口尺寸跟踪、拖动结束/取消和宽度持久化。 | Yes | 2026-10-01 |
| TASK-002 | 在 App.tsx 用 ResizableSidebar 包裹原侧栏内容；在 App.css 增加边界命中区域、悬停与聚焦反馈，确保顶部边界不是 Wails 窗口拖动区域。依赖 TASK-001。 | Yes | 2026-10-01 |

### Implementation Phase 2

- **GOAL-002**: 验证真实交互和资源构建后交付应用。

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | 浏览器检查鼠标拖动、指针捕获、上下限、重新加载偏好、窄屏再展开、双击、键盘、Escape 与取消后的光标恢复；检查正文/卡片仍对齐，无模型请求。依赖 TASK-002。 | Yes | 2026-10-01 |
| TASK-004 | 更新 README.md；完成前端生产构建并通过 scripts/build_lake_desktop.sh --install 签名安装；核对当前会话已结束再重启应用。依赖 TASK-003。 | Yes | 2026-10-01 |

## 3. Alternatives

- **ALT-001**: 原生 CSS resize 依赖面板角落，缺乏边界键盘操作及明确上下限，不采用。
- **ALT-002**: 引入第三方分割面板依赖；当前两列布局可以直接用指针捕获实现，不采用。

## 4. Dependencies

- **DEP-001**: 已安装的 React、TypeScript、Vite 和浏览器 Pointer Events。
- **DEP-002**: 现有 .shell 两列布局、统一消息列宽、签名构建脚本。

## 5. Files

- **FILE-001**: client/desktop/frontend/src/ResizableSidebar.tsx、App.tsx、App.css、WorkflowLibraryTree.tsx（存储不可用时保留内存中的目录展开状态）。
- **FILE-002**: README.md、本计划和临时浏览器验证脚本。

## 6. Testing

- **TEST-001**: 拖动后的实际侧栏宽度与 separator aria-valuenow 一致，松开后 reload 恢复。
- **TEST-002**: 1440px 上限 480px、680px 上限 320px；缩窗再展开恢复原偏好，没有横向溢出。
- **TEST-003**: 键盘与双击遵守边界；Escape 恢复原宽度；pointercancel/lostpointercapture 清除拖动光标与选区抑制。
- **TEST-004**: 模型请求为零；确认卡片和正文对齐；TypeScript/Vite build、签名及安装核对通过。

验证结果（2026-10-01）：桌面前端 34 项现有测试、桌面与 Web 生产构建全部通过。临时浏览器脚本 `/tmp/lake-sidebar-resize-smoke.cjs` 覆盖拖动、指针捕获、上下限、重新加载、窄窗口恢复、键盘、双击、Escape、指针取消/丢失捕获、窗口失焦、异常与不可用存储，以及正文和各类卡片对齐；没有模型请求。不可用存储检查同时发现并修复了工作流目录展开状态写入 localStorage 的未捕获异常。

通过签名脚本安装 `Lake-20261001-180939-33971.app`，构建目录只保留本次构建；安装应用和构建应用均通过 strict/deep 签名验证，应用代码及嵌入 CLI 的 CDHash 与产物一致。确认当前会话结束后重启，并恢复未发送的输入。在实际桌面应用中验证键盘 220→230px、鼠标拖动 230→330px、双击恢复 220px；草稿保持未发送。

后续修复（2026-10-01）：macOS 浮动滚动条覆盖侧栏行末的按钮。在 `.sidebar-scroll` 增加 16px 右侧内边距，并用 `scrollbar-gutter: stable` 避免传统滚动条切换时挤压内容。通过真实组件的临时本地页面检查 180/220/350/480px 宽度、滚动到底部、修改按钮聚焦及新建目录编辑状态：68–71 个按钮均位于内容边界内，可见按钮的中心命中正确元素，没有横向溢出；实测浮动滚动条不保留原生 gutter，但 16px 内边距仍有效。临时页面已移除，没有创建目录或运行工作流。

重新构建 Web 资源后，通过签名脚本安装 `Lake-20261001-182554-35699.app`；确认命令行二进制和应用内嵌 CLI 都包含最新 Web CSS 资源。实际桌面应用重启后保留用户的 294px 宽度，滚动查看工作流按钮与滚动区域间距，输入框保持为空且未发送请求。

## 7. Risks & Assumptions

- **RISK-001**: 顶部 Wails 窗口拖动层覆盖手柄，须用更高层级和 no-drag 显式排除。
- **ASSUMPTION-001**: 截图红色竖线指向侧栏和正文之间的宽度分界。

## 8. Related Specifications / Further Reading

[消息对齐](refactor-a2ui-input-layout-1.md)
[构建规则](../AGENTS.md)
