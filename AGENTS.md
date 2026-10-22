# Mandatory contribution workflow

- Before any repository change, read `CONTRIBUTING.md` and `docs/development-workflow.md`. These rules apply to humans and AI agents, including documentation, configuration, dependency and hotfix work. Historical plans do not override them.
- `develop` is the integration and Dev-validation branch. Start a short-lived branch from current `origin/develop` (`codex/<topic>` for AI work); open every ordinary PR against `develop`.
- Never commit or push directly to `develop` or `master`, force-push either branch, or merge into them outside a GitHub PR. Local merge followed by pushing a protected branch is not a substitute for a PR. Creating the initial `develop` ref at an existing `master` commit was a one-time bootstrap, not permission for direct updates.
- Daily work branches and PRs into `develop` do not run automatic CI. Run appropriate local checks and Lake Dev validation, record results and tested SHA, resolve feedback, and obtain explicit user authorization before merging that PR. Do not require absent CI on `develop`, directly push it, or treat no checks as proof of passing tests. Developing, committing or creating a PR alone does not authorize merging it. Do not use admin bypasses or auto-merge unless explicitly authorized.
- Automatic verification runs only for same-repository `develop -> master` PRs before merging; no duplicate CI on branch pushes or after the master merge. Manual workflow dispatch is available when explicitly requested. Release-asset publishing workflows remain separate and require release authorization.
- `master` is production. Only a same-repository `develop -> master` batch-release PR may target it. Feature/fix/docs branches must not target `master`. Accumulate and validate changes in Lake Dev; record the tested commit and checks. Prepare VERSION and release notes through a branch targeting `develop` first.
- Creating or merging a production release PR, creating release/asset tags, publishing Releases, or installing/restarting production requires explicit user authorization for that release operation. Merging a PR or producing CI packages does not authorize publishing. Keep `develop` after release; synchronize production history via a `sync/<topic> -> develop` PR when needed.
- Use the developer's authorized GitHub account; this repository does not require a particular username. Honor any account explicitly selected by the user for the current task. Before GitHub writes, verify `gh api user --jq .login` and repository permissions; ensure Git push authenticates as the same authorized account. Do not automatically switch accounts or use another stored account to work around missing permissions. See `docs/development-workflow.md` for multi-account authentication.
- If protection/default-branch setup is unavailable, report the limitation; documentation and hooks are not server-side enforcement. Never weaken checks or bypass protection to finish a task.

# Lake build and credential rules

- On macOS, build the user-facing `bin/lake` only with `scripts/build_lake.sh`. It signs each build with the persistent `Lake Local Development Code Signing` identity. The one-time `lake secrets migrate` command reads old Keychain items, so it must run from the signed binary.
- If the signing identity is missing, run `scripts/setup_lake_signing.sh` once, then use `scripts/build_lake.sh`. Do not silently fall back to an unsigned build.
- Never print, log, or commit model API keys or SSH private-key contents. Normal Lake operations use `~/.lake/secrets/` with private file permissions and must not read Keychain items.

# Local development

- On macOS, build and install the app used for local integration with `scripts/build_lake_desktop.sh --dev --install`; launch `~/Applications/Lake Dev.app`. This script calls the signed `scripts/build_lake.sh` build. Do not install the regular `Lake.app` for local development or restart it as part of a Dev iteration.
- Keep Dev and release separate: Dev uses bundle ID `com.cleanlakes.lake.desktop.dev` and `~/.lake-dev`; release uses `com.cleanlakes.lake.desktop` and `~/.lake`. Never point `LAKE_DEV_HOME`, `LAKE_DEV_WEB_DATA_DIR`, `--lake-home`, or `--lake-data` at release data, and do not copy or symlink release secrets into Dev.
- For standalone web development, pass an explicit isolated `--home` path and a free loopback port. Do not run a second backend against a home already in use by the Dev app. See `CONTRIBUTING.md` for the workflow.

# Frontend UI consistency

- Follow `docs/ui-guidelines.md` for all frontend UI work. Form dropdowns must use the shared `AppSelect`; do not add visible native selects in business components. Use `Glyph` for interface icons and `ProviderIcon` with local SVG assets for model-provider branding, rather than letter placeholders.

# Corner geometry for frontend agents

- Use the shared curve `--corner-window` (`superellipse(1.5)` on macOS 26) for rounded setting surfaces; keep a standard rounded fallback where unsupported. Do not mix sharp input corners, pill buttons and dialog-sized button radii in the same settings view.
- Settings use the tokens in `web-agent/web/src/theme.css`: dialog `--radius-settings-dialog: 22px`; cards, provider rows and grouped model lists `--radius-settings-panel: 14px`; inputs, `AppSelect` triggers, ordinary buttons and menu rows `--radius-settings-control: 10px`; small provider icon tiles `8px`; compact metadata badges `5px`. Switch tracks and status dots retain their pill/circle geometry. Keep the actual control dimensions unchanged; a radius must fit within half its smaller dimension.
- A grouped model list owns its outer radius and clips the first/last row backgrounds; inner separators remain straight. For tightly nested popover surfaces use outer radius minus inset (model popup `18px`, inset `5px`, row `13px`). Native and web supplier menus use an `18px` outer curve; native opaque menus have one physical-pixel border and no `NSScrollView` bezel or focus ring.
- Validate visible corners, hover/selection/focus and clipping in Lake Dev, light/dark themes and narrow windows. Matching computed `border-radius` alone is insufficient. Do not use double outlines, broad dialog shadows on inputs, or square backing surfaces at rounded corners. See `docs/ui-guidelines.md` for the full scale and platform rules.

- Inline resource references scale the same curve to their actual height: editor chip `24px` high / `--radius-composer-reference: 12px`, sent chip `22px` high / `--radius-message-reference: 11px`. Keep borderless type colors. After inserting/removing a reference, verify a painted caret and continued typing; DOM caret anchors must never enter the draft, clipboard payload or sent text.
