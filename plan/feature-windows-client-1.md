---
goal: Ship a Windows x86_64 client for the current Lake Go and React workbench
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Completed
tags: [feature, windows, desktop]
---
# Introduction

![Status: In progress](https://img.shields.io/badge/status-Completed-brightgreen)

Create a WebView2 client and Windows-compatible backend using the existing workbench. Produce a portable ZIP and per-user installer without starting persistent local test services.

## 1. Requirements & Constraints

- **REQ-001**: Support Windows 10 1809 or newer and Windows 11, x86_64.
- **REQ-002**: Preserve projects, conversations, SQLite persistence, model credentials and SSH terminals.
- **SEC-001**: Restrict private Windows data with user/SYSTEM ACLs; never log credentials.
- **CON-001**: macOS bin/lake continues to build through scripts/build_lake.sh with its persistent signing identity.
- **CON-002**: This host can cross-compile Windows executables but cannot confirm Windows GUI execution.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Separate OS-dependent backend operations.

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-001 | Add internal/platform helpers for private files, process environment and portable executable resolution; retain Unix mode checks. | ✅ | 2026-10-12 |
| TASK-002 | Split internal/web terminal startup, resize, locks and SQLite driver by build tags; use ConPTY and a pure-Go SQLite driver on Windows. | ✅ | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: Build and package the desktop application; depends on TASK-001 and TASK-002.

| Task | Description | Completed | Date |
|---|---|---|---|
| TASK-003 | Add client/windows WebView2 launcher with owned backend lifecycle, private runtime authentication and single-instance protection. | ✅ | 2026-10-12 |
| TASK-004 | Add scripts/build_lake_windows.py and client/windows installer recipe; include pinned PortableGit, WebView2 bootstrapper, licenses and checksums. | ✅ | 2026-10-12 |
| TASK-005 | Verify Windows PE architecture, package contents, Unix regressions and cross-compilation; add Windows CI smoke coverage and document runtime verification limits. | ✅ | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: The archived Electron client uses a different runtime and interface; it is not selected.
- **ALT-002**: WSL would impose a separate Linux installation; ship a Windows backend instead.

## 4. Dependencies

- **DEP-001**: github.com/UserExistsError/conpty v0.1.4.
- **DEP-002**: modernc.org/sqlite v1.46.1 for Windows builds only.
- **DEP-003**: github.com/jchv/go-webview2 pinned Go module and Microsoft Evergreen WebView2 Runtime.
- **DEP-004**: Official Git for Windows PortableGit archive, SHA-256 pinned in the build manifest.
- **DEP-005**: sevenzip and NSIS for package construction.

## 5. Files

- **FILE-001**: internal/platform and internal/web platform-specific implementations.
- **FILE-002**: client/windows launcher, manifest, installer and README.
- **FILE-003**: scripts/build_lake_windows.py, .github/workflows/tests.yml and Windows verification workflow.

## 6. Testing

- **TEST-001**: Windows amd64 backend and launcher cross-compilation succeeds with CGO disabled.
- **TEST-002**: Existing Unix Go race suite and frontend tests pass.
- **TEST-003**: Private Windows ACLs reject broad access; locks reject a second backend; SQLite restart preserves data.
- **TEST-004**: Windows terminal fixture preserves interactive input, resizing and cancellation.
- **TEST-005**: ZIP and installer are PE x86_64 where applicable and have matching checksum files.

## 7. Risks & Assumptions

- **RISK-001**: WebView2 GUI and ConPTY require native Windows validation; cross-compilation alone does not prove runtime behavior.
- **RISK-002**: PortableGit redistribution requires retaining its licenses and source download links.
- **ASSUMPTION-001**: The requested Windows architecture is amd64 and a per-user installation is preferred.

## 8. Related Specifications / Further Reading

[Current macOS client](../client/macos/README.md)
[ConPTY](https://learn.microsoft.com/en-us/windows/console/pseudoconsoles)
[WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)

Completed: Windows amd64 client/CLI and Windows-only tests cross-compile, ZIP and installer checksums are verified, 78 frontend tests and Unix Go race regressions pass. Native Windows GUI/ConPTY execution was not performed on this macOS host; the Windows CI smoke definitions are provided, not reported as executed. Evidence: docs/validation/lake-windows-x86_64.json.
