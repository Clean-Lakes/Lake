# Ordinary text: two visual styles

This supersedes the ordinary-text sizing and weight choices in `lake-typography-parity.md` and `lake-darker-text.md` following the user’s latest screenshot feedback.

- Feature commit: `4c4eee69`; signed Dev integration tested: `b128c15f`.
- Ordinary UI, conversation text, selected names, timestamps, plan references, plan dates, placeholder text and error captions use the same system font, 13px and 430 weight. Body strong/b keep markup semantics without changing the regular visual weight. Normal text has only foreground and muted colors; secondary is a muted alias. True page headings/branding, monospace code and semantic state colors retain their purpose.
- Consolidated 486 legacy font-size declarations in 28 CSS files; Dev-specific conflict resolution also normalized its additional permission/file captions. Shared tokens prevent body/UI size drift.
- `pnpm --dir web-agent test:frontend`: 418 passed, 0 failed. Signed `scripts/build_lake_desktop.sh --dev --install` and deep strict installed-app signature validation passed.
- Isolated browser, synthetic home `/tmp/lake-plan-toggle-20261022/home`, loopback port 51384. Rendered the installed Codex package CSS in an offscreen iframe: 17 sampled Lake ordinary-text roles matched its computed system font family, 13px size and 430 weight. Three plan list roles also matched each other in light/dark. At 430px, plan title/date remained 13px without document horizontal overflow. Body strong/error samples were explicitly synthetic DOM style probes; they do not test model behavior.
- Browser TaskSpace 34 finished; isolated backend stopped. No real resources or model requests were executed.
- Installed Dev package is fresh. Native desktop UI control returned `timeoutReached`; the already-running user window was not restarted or visually certified. Matching CSS parameters is not a cross-renderer pixel identity claim.
