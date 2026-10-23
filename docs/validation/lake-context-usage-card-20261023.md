# Context usage card — 2026-10-23

Source: `9eb4ca82` plus local context-card changes and the command-availability fix already submitted separately in PR #76. No model, credential or remote-resource operations were used for UI verification.

- The default panel is 292 × 213 CSS pixels, with a compact input-budget overview and collapsed details. Numeric text uses the shared system UI font with tabular figures. Chinese compact token counts retain the same measured values.
- The utilization percentage remains measured input divided by effective input budget, excluding reserved output. The cache percentage is explicitly the most recent request's cached input divided by that request's input; unknown data and measured zero remain distinct. There is no fabricated category breakdown or average cache metric.
- Existing 8 context measurement/model-switch/status tests passed. TypeScript and production Vite build passed. The isolated real-component fixture exercised hover entry, click-to-pin, expanded details, Escape/focus restoration, light/dark themes, unknown usage, actual zero, missing cache reporting and over-budget usage.
- In the synthetic example, 707,000 / 892,000 yields 79.3% and 185,000 remaining; 700,637 / 707,000 yields 99.1% cache hit. At 104.3% usage the bar caps at 100%, the real percentage remains visible, remaining input is zero, and the budget warning appears.
- At 390 × 720 the card remained inside the viewport. At 320 × 480, expanded details stayed within 12px viewport margins and scrolled internally without document overflow. Hovering from the trigger into the panel succeeded; Escape restored trigger focus. Private fixture screenshots remain outside the repository.

- `scripts/build_lake_desktop.sh --dev --install` passed with fresh TypeScript/Vite assets and the persistent signing identity. The installed backend matched the signed source build; deep strict app signature verification passed.
- Native accessibility later confirmed the new overview and expanded details with real measured usage (29.4% input-budget utilization and 99.7% most-recent cache hit). The active backend served the new build's JS/CSS asset names. Native automation initially timed out; the Dev process independently reloaded, so no agent-initiated restart is claimed. Browser TaskSpace 46 was finished and the isolated Vite fixture stopped.

Production app/data were not part of this iteration. The standalone PR excludes #75 and #76, and records its independently tested commit SHA and build checks in the PR body. Native Dev acceptance above used those other pending changes together with this UI patch.
