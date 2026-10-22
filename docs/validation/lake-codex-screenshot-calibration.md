# Screenshot-based typography calibration

Supersedes the 13px sizing/default-Codex comparison in `lake-two-text-styles.md` and older parity notes.

The user supplied a current side-by-side screenshot (`codex-clipboard-debae833-320b-4efe-a2ea-afa81508b6f7.png`, 2952×1722). Its ordinary Codex text was visibly larger than Lake despite both matching packaged defaults in a separate browser. Measuring text ink bands in that original image found approximately 26px vs 24px for black text/sidebar samples and 24px vs 22px for elapsed captions. The source defaults were not a reliable proxy for the user’s currently displayed Codex window.

Changed ordinary UI/body size together from 13px to 14px; retained the shared system font and regular 430 weight. Calibrated light-theme muted text to opaque `#8e8f90` from the supplied screenshot rather than compositing another shade over Lake’s off-white background. Normal black text remains unchanged. Native provider labels now also use 14px. Heading/logo/monospace semantics retain their intended roles.

- Feature: `74f6cdb4`; signed installed Dev integration: `6806c89bbd8be4175dce1c38be6508a838355f3e`.
- `scripts/build_lake_desktop.sh --dev --install`: passed; deep strict installed-app signature verification passed.
- Normally quit Dev through its application menu and reopened the installed app. Fresh backend PID 6673 started at 2026-10-22 21:42:18 Asia/Shanghai; runtime stylesheet `index-CgDeX8Wj.css` confirmed shared 14px and calibrated muted color. No release app/data were changed.
- Inspected actual WKWebView app screenshot after restart, covering sidebar labels, body, elapsed caption, saved-plan status and composer. Capture is local `/tmp/lake-calibrated-native.png`; not committed because it includes user conversations. Sidebar black text ink spans approximately 26 physical pixels and elapsed text approximately 24. CUA returns a JPEG capture, so individual pixel colors/edge bounds cannot certify lossless identity with the supplied PNG.
- The preceding broad typography change passed all 418 frontend tests. This follow-up changes only theme sizing/color, native menu font size and docs; signed build includes frontend type/build checks.

Matching the supplied screenshot is the validation reference. Do not revert ordinary size to 13px based only on packaged Codex CSS or claim pixel identity between Chromium and WKWebView.
