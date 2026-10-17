---
goal: Replace Lake's active workbench UI with the approved OxyNote-inspired design
version: 1
date_created: 2026-10-14
last_updated: 2026-10-14
owner: Lake
status: Completed
tags: [design, frontend, refactor]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implement the approved grayscale workbench mockup in the existing React application. The active product is `web-agent/web`; historical clients are not release entry points.

## 1. Requirements & Constraints

- **REQ-001**: Replace the old cream/teal design in all active CSS, SVG charts, xterm, and desktop window backgrounds; retain no legacy theme override layer.
- **REQ-002**: Use neutral navigation, white document-style conversation surfaces, compact controls, thin borders, and a navy primary action.
- **REQ-003**: Preserve session ordering, pending messages, IME shortcuts, approvals, permissions, resource scope, PTY input and resize, and streaming follow behavior.
- **SEC-001**: Do not access or print API keys, private keys, or Keychain items; use fictional data in visual verification.
- **CON-001**: Build the macOS user binary exclusively with `scripts/build_lake.sh`; preserve unrelated working changes.
- **PAT-001**: All product colors reference the shared `theme.css` tokens. Feature CSS owns component layout; shared theme tokens own visual values.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Replace every active visual styling source.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add `web-agent/web/src/theme.css` and theme preference initialization; replace palette, radii, shadows and typography in all active feature stylesheets. | ✅ | 2026-10-14 |
| TASK-002 | Update `App.tsx` navigation branding, navigation search and header; replace `Brand` and the Lake role icon with the approved geometric mark. Depends on TASK-001. | ✅ | 2026-10-14 |
| TASK-003 | Update `TerminalPane.tsx`, chart colors in `AIPanel.tsx`, `workbenchLayout.js`, and desktop window background constants to shared neutral colors. Depends on TASK-001. | ✅ | 2026-10-14 |

### Implementation Phase 2

- **GOAL-002**: Validate the entire workbench and signed output.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Run TypeScript checks, existing frontend regressions, production build and `scripts/build_lake.sh`. Depends on TASK-001, TASK-002, TASK-003. | ✅ | 2026-10-14 |
| TASK-005 | Verify synthetic conversation, navigation, approvals, terminal, settings, resource forms, small viewport and dark theme through the browser; save screenshots and validation notes. Depends on TASK-004. | ✅ | 2026-10-14 |

## 3. Alternatives

- **ALT-001**: A stylesheet appended over the old theme was rejected because it would leave competing legacy design values.
- **ALT-002**: Importing OxyNote's Vue application was rejected because Lake uses React and its operational contracts already exist.

## 4. Dependencies

- **DEP-001**: Existing React, Vite, TypeScript, xterm and pnpm; no Vue/Nuxt runtime is introduced.
- **DEP-002**: Persistent macOS Lake code signing identity and Go toolchain.

## 5. Files

- **FILE-001**: `web-agent/web/src/*.css`, `App.tsx`, `AgentIcon.tsx`, `TerminalPane.tsx`, `AIPanel.tsx`, `ModelSettings.tsx`, `main.tsx`, and `workbenchLayout.js`.
- **FILE-002**: `client/macos/Sources/LakeDesktop/App.swift` and `client/windows/theme_windows.go` desktop chrome backgrounds.
- **FILE-003**: `docs/validation/lake-oxynote-ui.md` and corresponding synthetic UI screenshots.

## 6. Testing

- **TEST-001**: Existing `pnpm --dir web-agent check` and `test:frontend` must pass, particularly keyboard, ordering, scrolling and terminal regressions.
- **TEST-002**: Inspect actual rendered surfaces, including modals and sidebar menus; confirm accessible keyboard focus and no horizontal overflow at mobile width.
- **TEST-003**: Verify static release assets and signed `bin/lake` contain the new design.

## 7. Risks & Assumptions

- **RISK-001**: Cascade changes may alter layout or disabled states; verify active and inactive controls and avoid moving selectors across media conditions.
- **RISK-002**: xterm and native desktop chrome have separate rendering; update their backgrounds explicitly.
- **ASSUMPTION-001**: The approved mockup defines visual direction; its illustrative charts are not new monitoring backend features.

## 8. Related Specifications / Further Reading

[OxyNote reference](https://github.com/oxynote/oxynote)

[Lake build rules](../AGENTS.md)
