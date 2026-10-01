# Lake build and credential rules

- On macOS, build the user-facing `bin/lake` only with `scripts/build_lake.sh`. It signs each build with the persistent `Lake Local Development Code Signing` identity. The one-time `lake secrets migrate` command reads old Keychain items, so it must run from the signed binary.
- If the signing identity is missing, run `scripts/setup_lake_signing.sh` once, then use `scripts/build_lake.sh`. Do not silently fall back to an unsigned build.
- Never print, log, or commit model API keys or SSH private-key contents. Normal Lake operations use `~/.lake/secrets/` with private file permissions and must not read Keychain items.
