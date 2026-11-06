---
goal: Refine sidebar navigation and white human bubbles in the dark theme
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake
status: 'In progress'
tags: [design, sidebar, frontend]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Polish the upper sidebar highlighted in the user's screenshot, keeping the existing navigation and runtime behavior.

The user's follow-up requires white human-message bubbles with dark text on the dark workbench; include that theme-only change in this UI iteration.

## 1. Requirements & Constraints

- **REQ-001**: Align the Lake wordmark, root navigation icons and section captions to the existing 16px content inset. Keep search on the same header baseline.
- **REQ-002**: Give Pilot a two-line navigation entry with a concise secondary caption, subtle resting surface, existing active surface and a compact trailing chevron.
- **REQ-003**: Use theme colors, shared corner geometry, visible keyboard focus and existing accessible navigation names.
- **REQ-004**: In theme.css set dark user-message background to #ffffff and foreground to #111111; in resourceReferences.css darken only resource references inside those user bubbles and keep local references legible.
- **CON-001**: Preserve search shortcuts, routing, avatar activity, specialist counts, resource hierarchy and task cancellation behavior.
- **SEC-001**: Use only Lake Dev and its isolated home for native validation; retain all already-installed candidate changes through a local integration build.
- **GUD-001**: Follow docs/ui-guidelines.md; add no font, icon, motion or component dependency.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Refine the existing header and Pilot entry.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In web-agent/web/src/sidebarWorkspace.css, tighten header margins, reduce the Dev badge to 16px height and use a 10px curved 28px search target with explicit hover/focus states. | Yes | 2026-11-06 |
| TASK-002 | In web-agent/web/src/PilotWorkspace.tsx, add the decorative caption 对话与任务 and replace the trailing arrow with Glyph next; in pilotWorkspace.css style the 52px entry and a one-line ellipsized 12px caption. | Yes | 2026-11-06 |
| TASK-003 | Update docs/ui-guidelines.md with the header hierarchy and retained navigation behavior. | Yes | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: Validate and deliver the focused style change.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Run existing frontend tests and Web type/build checks, including the requested dark user-bubble follow-up; no new implementation-mirroring style tests. Depends on TASK-001, TASK-002 and TASK-007. | Yes | 2026-11-06 |
| TASK-005 | Build a clean signed Lake Dev candidate containing the currently installed runtime; inspect actual light/dark, selected/hover/focus and narrow layouts, search and Pilot navigation. Record the SHA in docs/validation/sidebar-pilot-polish.md. Depends on TASK-004. | Yes | 2026-11-06 |
| TASK-006 | Open an independent PR to develop with the validation evidence and leave it unmerged. Depends on TASK-005. | | |
| TASK-007 | Change the two dark user-message tokens in web-agent/web/src/theme.css; add user-bubble-only resource color overrides in resourceReferences.css; document white bubbles in docs/ui-guidelines.md. | Yes | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: A large branded panel would consume navigation space and add another competing surface, so use the existing header and navigation row.
- **ALT-002**: An always-visible keyboard shortcut would crowd the compact header; keep the existing shortcut tooltip and accessible shortcut metadata.

## 4. Dependencies

- **DEP-001**: Existing Glyph, SuperRoleAvatar, sidebar alignment variables and window corner fallback.
- **DEP-002**: Installed Dev candidate 918cae17608d06ebb29d278daa64aaae2e64efb9; preserve its independent PR 190/191/192 code during local validation.

## 5. Files

- **FILE-001**: web-agent/web/src/sidebarWorkspace.css — brand and search geometry.
- **FILE-002**: web-agent/web/src/PilotWorkspace.tsx and pilotWorkspace.css — Pilot navigation entry.
- **FILE-003**: docs/ui-guidelines.md and docs/validation/sidebar-pilot-polish.md — design and native evidence.
- **FILE-004**: web-agent/web/src/theme.css and resourceReferences.css — dark human bubble palette and readable resource names.

## 6. Testing

- **TEST-001**: Existing frontend suite and build pass without changing navigation behavior.
- **TEST-002**: Native Dev shows aligned header controls, distinct Pilot resting/selected/hover states, visible keyboard focus and unclipped rounded surfaces in both themes and a narrow window.
- **TEST-003**: Search opens with the existing button and shortcut; Pilot navigation does not send messages or change task records.
- **TEST-004**: Dark native Dev shows white user bubbles and dark readable text; light user bubbles remain black. Existing shared selectors cover image captions and resource references without changing message records.

## 7. Risks & Assumptions

- **RISK-001**: Shared navigation selectors can override caption display or header radii; validate actual rendering rather than computed radius alone.
- **ASSUMPTION-001**: The highlighted region is the upper navigation, so task execution and the resource tree remain outside the visual scope.

## 8. Related Specifications / Further Reading

- [Contributing](../CONTRIBUTING.md)
- [Development workflow](../docs/development-workflow.md)
- [UI guidelines](../docs/ui-guidelines.md)
