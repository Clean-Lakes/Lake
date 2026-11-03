# Conversation island stability — 2026-11-03

## Cause and change

The island preferred width was derived from the rendered status content. Below
the 300px container breakpoint, that content becomes a 114px grid segment; above
it, it returns to its intrinsic width. An ordinary standby specialist with no
inspector therefore alternated between 284px and 336px without user input.

Measure the intrinsic title, badge text and controls instead. Budget badge padding
from a shared preferred-size token, since its compact padding also changes at the
breakpoint. Reserve compact status space from intrinsic size once, retaining the
full specialist title when the conversation rail has room. Pilot and terminal
width budgets retain their existing behavior.

## Tested sources

- PR code: `637c2b2366b94e1cad1a8e39f2a277670a6fe443`, from `origin/develop`
  `2b233a4a`.
- Installed macOS Dev: `858e190e4083af0992142160912bcd3d127dabff`, clean build,
  version 0.3.24. This is the previously installed `b1c338cd` plus the same two
  UI commits, preserving the user's pending specialist-channel work. Local branch
  `codex/header-jitter-dev-validation` retains this exact Dev source; it is not a
  release or a proposed integration of that other work.

## Checks

- Node 24.14.0 / pnpm 10.33.4: `pnpm test:frontend`: 569 passed, 0 failed.
- `pnpm build:web`: type checking and production build passed. Existing bundle
  size warning remains.
- `python3 scripts/check_adk_runtime_boundary.py`: passed.
- `scripts/build_lake_desktop.sh --dev --install`: signed backend and app built
  and installed. `codesign --verify --deep --strict ~/Applications/Lake\ Dev.app`
  passed. Build manifest identifies the clean Dev SHA above.
- Dev was stopped through **停止内核并退出**, then reopened. Its original specialist
  conversation was inspected in native WKWebView: full title and standby badge
  visible, with no observed recurring expansion. No production app/data used.

## Browser regression

Use the real App fixture at
`/test/fixtures/pilot-island.html?header-stability&theme=light` (or `dark`).
`window.lakeHeaderStabilityQA.title(value)` changes the title through the normal
SSE/snapshot path. All data is fictional and in memory.

Before the fix, 100 samples at 30ms intervals contained repeated alternation
between 284px and 336px. After the final change, wait for the requested title to
render and 1.8s for background-tab layout delivery, then sample 40 times at 30ms.
[Raw results](header-island-stability/browser.json) cover both themes:

- Original title: constant 336px; full title visible.
- Padding-breakpoint title ending in `aai`: constant 302.9921875px; full title
  visible. This catches feedback from the compact badge padding itself.
- Long title: constant 334px; intentional title ellipsis.
- Composer rail constrained to 240px: constant 240px, respecting the rail.

Pilot parallel work was separately sampled at constant 510px after settling.
Browser measurements use Chromium; native WKWebView verification is visual,
not a claim of instrumented per-frame native geometry. Native light theme,
Windows and a long-duration live-stream soak were not exercised.

## Scope and rollback

UI measurement and a test fixture only; no task, safety, memory, credential,
schema or remote-operation semantics change. Revert the UI commits to roll back.
No CI was triggered or treated as passing, and no PR merge or release is
authorized by this validation.
