# Codex desktop typography parity

Date: 2026-10-22. This supersedes the earlier blanket-500 approach recorded in `lake-darker-text.md`.

## Reference and implementation

The installed Codex app is 26.1007.30912 (20156). Ordinary offline ASAR inventory extracted its packaged CSS for inspection; no application settings, accounts or conversations were read. Reference CSS was rendered without scripts in an isolated iframe. No packaged CSS or fonts were copied into Lake. The reverse-engineering skill's CLI diagnostic was available; the typography facts come from the offline CSS inspection, not a claimed REA Evidence record.

| Role | Shared value |
| --- | --- |
| Font family | `-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` |
| Body, ordinary UI and gray metadata | 430 |
| Medium emphasis and selected items | 500 |
| Headings and strong | 600 |
| Code | 400 |
| Light primary | #1a1c1f |
| Light secondary / muted | primary at 70% / 50%, mixed in oklab |
| Dark primary | #dfdfdf |
| Dark secondary / muted | white at 70% / 50% |

All 41 business CSS files were scanned: 144 explicit font-weight declarations now use shared tokens or inherit. 550/650 and other independent numeric weights are removed. UA headings and strong also use the shared semibold token. One inline terminal font family is intentionally monospace. The single AppKit-drawn provider menu now uses a system-font OpenType wght axis of 430, or 500 for the checked item, plus the same light/dark primary colors. A standalone AppKit/CoreText font probe confirmed wght 430 is retained on this Mac; the system font reports a supported wght range of 1..1000.

## Validation

- `pnpm --dir web-agent test:frontend`: 420/420 passed.
- Signed `scripts/build_lake_desktop.sh --dev --install`: passed, including TypeScript/Vite and Swift build.
- `codesign --verify --deep --strict` and diff checks: passed.
- Browser comparison against packaged reference CSS: identical computed font family, weight and color for body, gray status, placeholder, unselected sidebar, selected sidebar and elapsed time, in both light and dark themes.
- Menus: current item 500, other items 430. Permissions: title 600, labels 430. Plan page and Markdown headings: 600, body/metadata 430.
- Desktop light and 430 px dark screenshots visually inspected; no horizontal overflow. Browser task 32 finished and isolated backend stopped. An intermittent browser-wrapper menu click required a DOM event fallback after inspecting the unchanged state.

Final installed source: `3d070217c8d0fb4f8b2ac1d19113bdab062d0b76`. Backend SHA-256: `38d7e80e05697be8ac1807a889b8cd52913effbf1cb7ecb68664e2bb98dd7492`. Web acceptance was at `c417a1f07f2b1b2c3aa8a7e2cd5007dd607d4b6b`; the web source is identical in the final installed build. Later changes affect the AppKit menu only. The integration branch retains previously installed Dev UI work; the feature branch is `codex/darker-text`.

## Limits and native acceptance

The reference establishes packaged default parameters. Codex custom appearance settings were not inspected, and font sizes/layout were left unchanged. Matching these parameters does not certify pixel-identical Chromium/WKWebView rasterization. Native automation still returned timeoutReached, including a fresh lookup after a tool reset: the installed Lake Dev needs a manual full quit/reopen and native visual acceptance. No production app/data, model or resource operation, remote write or PR update.

Reference asset hashes, measured values and audit details are in `lake-typography-parity.json`.
