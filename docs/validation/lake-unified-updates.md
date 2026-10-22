# Unified update entry and resource section

Date: 2026-10-14 (Asia/Shanghai).

The header refresh slot is now the sole application-styled update entry. The sidebar Windows entry and native macOS toolbar/popover have been removed. The dialog shows current version/channel, live check state, Markdown release announcements, Git repository address and release-page link. It uses the existing neutral palette, typography, borders and shadow, with a neutral primary action and no focus outline around the dialog container. Keyboard focus remains visible on controls and returns to the trigger on Escape/close.

macOS exposes a same-origin, main-frame-only WebKit reply bridge for state/check/install. It forwards the existing updater state and installer safeguards. Development builds can manually preview release metadata, with installation still disallowed by the native development profile and the frontend. Formal builds retain their automatic checks and authenticated installer flow. Windows uses its existing bridge. Browser sessions can read stable master release announcements through the public GitHub API and have no installation action. The release repository is https://github.com/Clean-Lakes/Lake.

The resources section now has a layer icon, semibold title, subdued count badge, separate section chevron, separators and spacing. Folder rows retain ordinary folder icons, regular labels and their original hierarchy. Section collapse and resource creation retain their existing handlers.

Validation: all 122 frontend tests pass, including numeric version ordering, draft/prerelease/branch exclusions, current/local-ahead release notes and no downgrade announcements. The signed Dev production build and strict signature verification pass. LakeUpdateTests pass profile isolation, release/architecture/assets/checksum/archive policy groups and cleanup boundaries. Real GitHub announcements were loaded successfully through both the browser fallback and the actual macOS Dev bridge; the latter identified the development channel and exposed no install action. Both Git links were visible. At 390px, the dialog fit without horizontal overflow; Escape restored focus. Browser error logs were empty.

The running Dev investigation was allowed to finish before replacing/restarting the app. Four user-created sessions remained present after restart. Tests did not issue model calls, create sessions/resources or install a remote release. Formal backend remained PID 65427 on port 49288. Final Dev backend is PID 75620 on port 57325. Previous signed bundle: ~/Library/Application Support/Lake Dev/builds/Lake-Dev-before-update-dialog-style-3df2efa3.app.

Screenshot of the installed frontend, read-only browser view: /Users/lingyunxieqing/.codex/visualizations/2026/10/12/01a12eda-1990-7ee3-818b-d065e5298b1c/lake-unified-update-dialog.png
