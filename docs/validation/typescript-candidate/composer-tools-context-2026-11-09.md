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
