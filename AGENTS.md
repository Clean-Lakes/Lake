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
