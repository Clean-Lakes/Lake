---
goal: Add visible and context-menu deletion for projects, resources and folders with restoration
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Completed
tags: [feature, navigation, deletion]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Expose deletion on project, folder and resource rows. Move deleted navigation entries to a recoverable list, preserve connection settings and history, and prevent deleting resources being used.

## 1. Requirements & Constraints

- **REQ-001**: Provide visible trash controls and an application context menu rather than the browser Back/Reload menu.
- **REQ-002**: Support every nesting level, nonempty folders and Local machine resources; deleting a folder promotes its contents to its parent.
- **REQ-003**: Restore project/resource/folder entries from a Deleted list; preserve history and credentials.
- **SEC-001**: Reject deletion while the affected project has an active AI turn or affected resources have connected terminals/pending actions; archived resources cannot be used.
- **CON-001**: Test exclusively with synthetic data; use signed build scripts and preserve the user backend.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Add recoverable deletion and access checks.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add navigationTrash storage, archive/restore methods and routes; filter deleted projects/resources from catalog, session scope and resource tree seeding. | Yes | 2026-10-12 |
| TASK-002 | Record folder deletions in resource_tree.go and restore folders/remaining promoted children. Depends on TASK-001. | Yes | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: Add visible controls and confirmation/restore UI.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add NavigationDelete.tsx and context-menu controls to ResourceTree.tsx and project rows; expose Deleted list and reconcile routes after changes. Depends on TASK-001 and TASK-002. | Yes | 2026-10-12 |
| TASK-004 | Run archive/restore/scope/race tests and frontend checks; verify context menu, nonempty-folder deletion and resource restore in a synthetic browser. Depends on TASK-003. | Yes | 2026-10-12 |
| TASK-005 | Build/install signed app, capture screenshot/report and document behavior. Depends on TASK-004. | Yes | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: Hard resource deletion breaks historical foreign keys; retain records and hide archived entries from active scopes.

## 4. Dependencies

- **DEP-001**: Existing resource-tree transactions promote folder children; Store locks serialize catalog and resource scope changes.

## 5. Files

- **FILE-001**: internal/web/navigation_trash.go, schema.sql, store.go, resource_tree.go and server.go implement persistence and routes.
- **FILE-002**: web-agent/web/src/NavigationDelete.tsx, ResourceTree.tsx, App.tsx, styles.css, api.ts and shared/contracts.ts implement controls.

## 6. Testing

- **TEST-001**: Archive/restore resource/project without losing credentials/history; deleted resources cannot be referenced or reseeded.
- **TEST-002**: Remove nonempty nested folders, preserve/promote contents and restore their identities.
- **TEST-003**: Reject busy resources, active project work and cross-project restoration/mutation; verify custom right-click menu in browser.

## 7. Risks & Assumptions

- **RISK-001**: A restored resource's old folder may no longer exist; restore it to the project root.
- **ASSUMPTION-001**: Deletion here manages Lake configuration, not files or services on hosts.

## 8. Related Specifications / Further Reading

[Resource directory tree](feature-resource-directory-tree-1.md) · [Credential rules](../AGENTS.md)

## 9. Validation Results

- TypeScript check, 79 frontend tests, targeted navigation/resource-tree race tests and the full web race suite passed. The whole-repository race run has an unrelated AI catalog assertion expecting 42 tools while the current catalog has 43; no AI catalog code was changed for this feature.
- Browser verified visible project/resource/folder controls, a custom right-click menu, resource archive/restore, nonempty nested folder deletion/promotion/restoration, and complete project removal/restoration.
- Built and installed the signed desktop app. No production entries were deleted and the current user backend was preserved.
- [Validation report](../docs/validation/lake-navigation-delete.json) · [Verified menu](../docs/validation/lake-navigation-delete-menu.png)
