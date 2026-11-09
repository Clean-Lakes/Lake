---
goal: Move attachment entry inside the composer and disclose context usage in the model menu
version: 1
date_created: 2026-11-09
last_updated: 2026-11-09
owner: Lake maintainers
status: 'Completed'
tags: [composer, frontend, macos]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

Place the attachment plus inside the message surface. Keep normal context usage out of the footer and accessible through the existing model menu, including its native webview.

## 1. Requirements & Constraints

- **REQ-001**: Move the existing attachment input/button into the left of composer-body; preserve upload, paste/drop, keyboard focus and drafting behavior.
- **REQ-002**: Hide normal/unknown context indicators in the footer. Show a quiet warning at the existing 85% measured input-budget threshold; keep compaction failures in their existing conversation notice.
- **REQ-003**: Add a collapsed context usage row to the model menu with existing accurate budget/cache/total details. Serialize only session, context, usage, selected model ID and status into the native model panel, never cards or transcript.
- **CON-001**: Reuse AppSelect, Glyph, theme and corner tokens. Preserve actual usage calculations, current-model matching, reasoning save behavior, native authentication and Dev isolation.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Deliver the composer arrangement and shared disclosure.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | Move the attachment entry in App.tsx and add scoped composer button layout in styles.css. | Yes | 2026-11-09 |
| TASK-002 | Add menu/warning presentations to ContextUsage.tsx, preserve existing calculations and share the details body; style in contextUsage.css. | Yes | 2026-11-09 |
| TASK-003 | Pass minimal context props via ComposerModelSelect.tsx and nativeModelPanel.ts; include summary focusables in NativeModelPanelPage.tsx. Depends on TASK-002. | Yes | 2026-11-09 |

### Implementation Phase 2

- **GOAL-002**: Validate interaction and deliver a reviewable Dev build.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | Run frontend type/checks and context/model regressions. Check browser keyboard/light/dark/narrow layouts and signed Dev attachment, drafting and native-menu entry; record tested SHA and incomplete native expansion/theme/resize checks. Depends on TASK-001 through TASK-003. | Yes | 2026-11-09 |
| TASK-005 | Update ui-guidelines.md, validation notes and the open develop PR; do not merge or publish. Depends on TASK-004. | Yes | 2026-11-09 |

## 3. Alternatives

- **ALT-001**: Removing usage data entirely loses troubleshooting access.
- **ALT-002**: Hover-only footer controls remain hard to discover and require another toolbar target.

## 4. Dependencies

- **DEP-001**: Existing composer attachment handler, ContextUsage calculations and shared/native model panel.

## 5. Files

- **FILE-001**: web-agent/web/src/App.tsx, styles.css, ContextUsage.tsx, contextUsage.css, ComposerModelSelect.tsx, nativeModelPanel.ts, NativeModelPanelPage.tsx.
- **FILE-002**: web-agent/web/test/context.test.ts, docs/ui-guidelines.md and docs/validation/typescript-candidate/composer-tools-context-2026-11-09.md.
- **FILE-003**: web-agent/web/test/fixtures/composer-model-workbench.tsx and native-model-panel.tsx provide synthetic context usage for browser checks without model calls.

## 6. Testing

- **TEST-001**: Normal, zero and unknown usage produce no footer indicator; 85%+ shows the warning with accessible details. Selected-model mismatch must not show stale usage.
- **TEST-002**: Shared/native model menus disclose current session usage without changing the selected model; keyboard controls and Escape remain correct.
- **TEST-003**: Attachment plus remains inside the composer in empty, multiline, narrow and dark layouts without obstructing text or send/stop actions.

## 7. Risks & Assumptions

- **RISK-001**: The native model menu uses another webview; context props must be sent explicitly and contain no transcript.
- **RISK-002**: Expanded context details can crowd short popovers; bound the inner detail height and verify scrolling/clipping.
- **ASSUMPTION-001**: The plus continues to open the current attachment chooser; the user has not requested a new action menu.

## 8. Related Specifications / Further Reading

[UI guidelines](../docs/ui-guidelines.md), [workflow](../docs/development-workflow.md).

Delivered source: `b7ffca2ebfcf819db8a644b4808ed77d689e5bf0`. See [validation and native-check limitations](../docs/validation/typescript-candidate/composer-tools-context-2026-11-09.md).
