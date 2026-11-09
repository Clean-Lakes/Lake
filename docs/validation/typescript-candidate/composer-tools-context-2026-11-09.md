# Composer attachment and context disclosure

Tested source / signed Dev SHA: `b7ffca2ebfcf819db8a644b4808ed77d689e5bf0` (`dirty: false`). Later validation/plan changes are documentation only. TypeScript backend artifact SHA256: `f6c6da4ae56e7ccf9036fd8d21a12d156f2514f8e8b32c5f48a52ebb333c817e`.

## Behavior

- The existing attachment chooser now sits inside the input surface, left of the editor. Its 30px control aligns with send/stop at the bottom when the draft grows; upload, paste/drop and send handlers retain their existing behavior.
- Normal, unknown and stale-model context usage do not paint a footer ring. The model menu has a collapsed “上下文用量” row, showing measured percentage or “暂无实测”. Budget, remaining space, cache and request totals are available on expansion.
- Measured input-budget usage at 85% or higher shows a warning in the footer. At 100% it reads “上下文需整理”; narrow composers use an accessible icon. Existing conversation notices still explain compaction failures.
- The native model panel receives only session/context/usage/model/status fields, with no conversation cards or transcript. Expanded details stay in the menu flow with a bounded scroll area. `summary` participates in native keyboard traversal.

## Local checks

Pinned Node `24.14.0` from `third_party/.lake-cache/node-v24.14.0-darwin-arm64/bin` was used.

| Check | Result |
| --- | --- |
| `pnpm --dir web-agent check` | Passed |
| `web-agent/node_modules/.bin/tsx --tsconfig web-agent/web/tsconfig.json --test web-agent/web/test/*.test.ts` | 767 tests passed; no skips/failures |
| `git diff --check` | Passed |
| `scripts/build_lake_desktop.sh --dev --install` | Passed; signed macOS arm64 Dev installed |
| `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app` | Passed |

Two context tests cover hidden normal/zero/unknown/model-mismatched usage, the 85% warning threshold, absence of the ring, and initially collapsed menu details. Backend execution logic is unchanged by this UI commit; backend regressions remain recorded in the preceding PR validation documents.

## Browser interaction

Ego Browser used the real App and native-panel React fixtures served only on loopback, with synthetic context usage and no live model/server operations.

- Wide light layout: attachment control fully inside the input; no normal footer indicator.
- Model menu: 22.5% row initially collapsed; Space expands it without selecting another model; Escape closes the model menu. Details remain inside the popup and scroll when needed.
- Found and fixed an interaction with the older global fixed-position `.ai-context-panel` rule: the menu now explicitly uses static positioning. Rechecked the expanded section and popup bounds after the fix.
- Synthetic 90% case: warning and budget details visible; popover fits the viewport and closes on Escape.
- 660 × 740 light/dark layouts: no horizontal overflow; attachment control remains inside the input. A 375px exploratory viewport showed the existing navigation/drawer layout overflowing; phone layout is not claimed as validated desktop behavior.
- Native-panel fixture at 320 × 520, dark theme: expanded context panel and popup remain within their bounds. The full usage breakdown is readable.

Local visual captures inspected: `/tmp/lake-composer-light.png`, `/tmp/lake-composer-context-menu-fixed.png`, `/tmp/lake-composer-dark-660.png` and `/tmp/lake-composer-native-panel-dark.png`. These are local artifacts, not release evidence or committed screenshots.

## Signed Lake Dev interaction

Stopped the previous Dev kernel through “停止内核并退出”, installed the signed build, and opened `~/Applications/Lake Dev.app` with the isolated `~/.lake-dev` profile.

- Light window: plus is inside the composer. The normal context ring is absent.
- Plus opens the native file chooser; cancel returns to the composer without adding a file.
- Pasted a two-line test draft, observed a painted caret and enabled send control, and verified plus/send stay at the bottom of the expanded surface. Cleared this draft without sending it.
- Native model panel opened and displayed the new collapsed “上下文用量 暂无实测” row for the current specialist session. No model was changed.
- Subsequent native input stopped responding during the review. Actual native expansion, native theme switching and resized-window clipping were not completed; those interactions are covered by the shared/native browser fixtures above, and are not claimed as native Dev passes.

No real remote command, model message, file upload, production restart, permission change, merge or release was performed for this UI validation.

## Follow-up: matching button curves

The user's hover screenshot still exposed the old 5px action-button radius. Source and signed Dev SHA: `026c7360000bcb38e835779c80a5735b04f4c85e`, `dirty: false`; backend artifact SHA256: `9c4f862b6a76d4693a1495dc8fce6ccacb97f4c56b42d0304a15215d627165a9`.

Attachment and send/stop controls now share `--corner-window`, scaled to `--radius-composer-action: 15px` within their existing 30 × 30px targets. The shared nine-slice fallback covers both controls. Selector specificity preserves editor/message reference radii at 12px/11px.

- Frontend type check, signed Dev build/install, strict/deep codesign verification and whitespace check passed. This follow-up is CSS-only; no new behavior tests were added and the preceding 767-test run was not represented as a rerun.
- Browser: inspected the actual App's light hover, dark 660px layout with forced WKWebView fallback, and keyboard-visible focus. Both controls measured 30 × 30px / 15px with `superellipse(1.5)`; fallback fill masks use the shared local SVG at 15px. Reference probes retained 12px/11px. Local screenshots: `/tmp/lake-composer-corner-light-hover.png`, `/tmp/lake-composer-corner-dark-fallback.png`, `/tmp/lake-composer-corner-focus.png`.
- Signed Lake Dev: attachment chooser opens and Escape cancels; keyboard focus returns through the composer to the attachment control. Inspected the painted focus contour in light and dark themes, including the minimum-width desktop window. Controls and focus remain inside the input surface without clipping. Restored the original light theme and window size after review.
- No message or attachment was sent and no live task was started. Active stop execution was not exercised for this style-only change. The preceding native context-menu expansion limitation is separate and remains recorded above.

## Follow-up: one input surface and aligned bottom edges

Source and signed Dev SHA: `56f1cc1afa732e8f48f914c40a87ad1709c44239`, `dirty: false`; backend artifact SHA256: `cabf16a079af43b818fd13add19419ee0420a9d193acc2981ad94e5a74001c5d`.

The editor occupies the upper row of one input surface. Attachment, permission, Plan / Pilot mode, model/context and send/stop controls share its lower toolbar. Existing handlers, eligibility checks, file input, refs and form submission remain unchanged. The dock and sidebar workspace entry share `--workbench-bottom-inset: 8px`, including responsive dock rules. Narrow layouts retain accessible control labels while hiding optional visible labels. The old SRE toggle keeps its content width rather than inheriting the 28px icon-only permission target.

- Final frontend type check and 767 frontend tests passed (no failures/skips), as did whitespace checks, signed Dev build/install and strict/deep codesign verification.
- Browser, real App with synthetic data: toolbar buttons inside the surface; bottom-edge difference from workspace entry exactly 0px in the wide light window and at 850px with a 474px composer. Permission dialog, model menu, context disclosure and Escape remain functional. Pasted a multiline draft and observed continued editor focus.
- Browser dark/forced WKWebView fallback: inspected multiline/narrow layout with a synthetic long model name and stop-scope label. Fixed SRE label overflow; mode/model gap is 4px and mode content fits. At 660px, the 90% context warning and all toolbar buttons stay inside with no overlap or horizontal overflow. Synthetic labels were visual probes, not live execution or a changed model selection.
- Signed Lake Dev light window: all controls inside the input; outer bottom aligned with the sidebar workspace entry. Multiline input grows upward, leaves the toolbar on the bottom and keeps a painted caret; cleared the draft without sending. Permission dialog opens from its new position. Native model panel opens and its context row expands to the budget/remaining/unknown-data section; Escape returns to the workbench. No provider, model, Plan mode or permission was changed.
- Subsequent native dark/resize review was not performed after another task began running in the window; its state was left alone. Dark/narrow coverage for this layout is the browser evidence above, while the preceding button-curve revision has its own native light/dark/minimum-window record. Native full usage-breakdown scrolling and active stop execution were not exercised.

Local inspected screenshots: `/tmp/lake-composer-unified-light.png`, `/tmp/lake-composer-unified-dark-narrow-fixed.png`, `/tmp/lake-composer-unified-warning-660.png`. This revision does not change backend execution, authorization or acceptance rules, and did not run a remote command, send a model message, upload a file, merge a PR or publish a release.
