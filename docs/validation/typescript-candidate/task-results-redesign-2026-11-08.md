# Task result inspector redesign

Tested source: `17acbf1109783cf5ae2302cffda197ad171fed5a` on `codex/typescript-cutover-repair`, PR #199 targeting `develop`.

## Result

The task overview presents one canonical verdict, the exact specialist source and the stored update time. A passed task no longer repeats both “已验收” and “验收通过”. Pending/insufficient/failed states remain distinct; joint tasks retain their unified verdict and individual contributor states.

The result pane renders the saved summary through shared `AssistantMarkdown` and task-scoped recorded file references. Links, paragraphs, lists, inline code and tables retain their meaning instead of displaying raw Markdown. Raw HTML is suppressed and report images are displayed as alternate text without fetching images. Long links wrap; tables and code retain their own scrolling.

“核验依据” separates the canonical business receipts from the report. Receipts and step history are initially collapsed; failed and unknown receipts remain available unchanged. An empty receipt set is explicit rather than a disabled disclosure. Selecting another execution resets its disclosures, while updates to the same task preserve them. No acceptance, routing, execution or permission logic changed.

## Local verification

- `pnpm --dir web-agent check`: passed.
- `pnpm --dir web-agent test:frontend`: **761 passed**, no failures or skips.
- `pnpm --dir web-agent build:web`: passed; existing large-chunk advisory remains.
- `python3 scripts/check_adk_runtime_boundary.py`: passed.
- New rendering coverage includes Markdown links/lists/tables/code, unsafe URLs, raw HTML and external images, one truthful verdict, incomplete acceptance, failed tasks, and folded step history. Existing joint-task tests retain exact member/session/receipt ownership.
- Runtime suites were not rerun for this frontend-only change; this is not a new backend-runtime acceptance claim.

## Signed Lake Dev

Stopped the previous Dev kernel through the native menu, passed Dev preflight, then built and installed with `scripts/build_lake_desktop.sh --dev --ts-candidate --install` from the clean tested source. Installed provenance reports that exact source SHA, `dirty: false`, TypeScript backend, and backend SHA256 `dd1aa28089a3866b4f1d16b83219b6603a5f59c5b8f8daa6c390a71ba0f09462`. `codesign --verify --deep --strict` passed. Only `~/Applications/Lake Dev.app` and its isolated Dev data were used.

Native verification used an existing completed task's stored report, without issuing another model turn, querying its linked documents, or executing resource tools:

- Light and dark themes: one accepted badge, readable wrapped document links and list descriptions, separated evidence section.
- Desktop approximately 1512 × 788 logical points, narrower 1120 × 727 and overlay layout at 1024 × 688: content and close/tab controls remain reachable; report scrolling stays within the inspector.
- Expanded the two original business receipts and the step history; original tool records and step outcome remain visible. Return collapses the receipt disclosure; left-arrow switches the execution tab back to results.
- Execution tab still lists its original MCP and task-completion records.
- Restored the original light theme after the checks. Private document contents, URLs and screenshots were not added to the repository.

Read-only hashes of all stored `superGoals`, `superOperations`, `superAcceptance` and `superDecisions` rows matched before installation and after native verification. The redesign did not mutate those ledgers. Production Lake was not installed or restarted. PR #199 remains open; no merge or release was performed.
