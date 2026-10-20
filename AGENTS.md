# Mandatory contribution workflow

- Before any repository change, read `CONTRIBUTING.md` and `docs/development-workflow.md`. These rules apply to humans and AI agents, including documentation, configuration, dependency and hotfix work. Historical plans do not override them.
- `develop` is the integration and Dev-validation branch. Start a short-lived branch from current `origin/develop` (`codex/<topic>` for AI work); open every ordinary PR against `develop`.
- Never commit or push directly to `develop` or `master`, force-push either branch, or merge into them outside a GitHub PR. Local merge followed by pushing a protected branch is not a substitute for a PR. Creating the initial `develop` ref at an existing `master` commit was a one-time bootstrap, not permission for direct updates.
- Daily work branches and PRs into `develop` do not run automatic CI. Run appropriate local checks and Lake Dev validation, record results and tested SHA, resolve feedback, and obtain explicit user authorization before merging that PR. Do not require absent CI on `develop`, directly push it, or treat no checks as proof of passing tests. Developing, committing or creating a PR alone does not authorize merging it. Do not use admin bypasses or auto-merge unless explicitly authorized.
- Automatic verification runs only for same-repository `develop -> master` PRs before merging; no duplicate CI on branch pushes or after the master merge. Manual workflow dispatch is available when explicitly requested. Release-asset publishing workflows remain separate and require release authorization.
- `master` is production. Only a same-repository `develop -> master` batch-release PR may target it. Feature/fix/docs branches must not target `master`. Accumulate and validate changes in Lake Dev; record the tested commit and checks. Prepare VERSION and release notes through a branch targeting `develop` first.
- Creating or merging a production release PR, creating release/asset tags, publishing Releases, or installing/restarting production requires explicit user authorization for that release operation. Merging a PR or producing CI packages does not authorize publishing. Keep `develop` after release; synchronize production history via a `sync/<topic> -> develop` PR when needed.
- Use local GitHub CLI account `bearqy`: verify `gh api user --jq .login`; if needed run `gh auth switch --hostname github.com --user bearqy`. Do not use another stored account to work around missing permissions.
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
