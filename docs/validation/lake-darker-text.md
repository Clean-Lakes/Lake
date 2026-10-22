# Darker workbench text — local Dev validation

Date: 2026-10-22. Feature commit: `8b6eb11d`; base: origin/develop `48c08c6d`.

Light primary text changes from #222222 to #0d0d0d; secondary text changes from #555555 to #4a4a4a. Sidebar session, resource and folder names use the shared primary text token. Muted metadata, font family/size/weight and dark-theme palette retain their semantics.

Built from local integration commit `97ea1edb826e905948a4e60c4212964007028df2`, combining the feature with installed Dev head `2e86530a75117514497d2cfa022bf8b7a9fad6bb` to preserve existing Dev changes. `scripts/build_lake_desktop.sh --dev --install` passed, including TypeScript/Vite validation; deep/strict codesign verification and git diff checks passed. No new automated tests for this CSS-only adjustment.

Isolated browser verification: title, body and navigation names compute to rgb(13,13,13) in light mode; metadata stays rgb(115,115,115). Dark body remains rgb(238,238,238); 430 px layout has no horizontal overflow. Light desktop and dark narrow screenshots were visually inspected. Browser task 29 finished and isolated backend stopped after checks.

Fully quit the old Lake Dev and launched the installed package; native screenshot verified the actual session plan page with the darker titles and sidebar names. No model requests or resource operations. Production Lake was not installed or started. No remote write or PR update.

Installed backend SHA-256: `9a7a888dfc093ff51a65fe4c9230ff90c07b3ccad90a276785e5a04303e0a335`.


## Follow-up: match the fuller reply strokes in the reference

The user supplied a side-by-side screenshot showing that palette changes alone left Lake's assistant text visibly thinner. Assistant prose now uses a system-first font stack and weight 500, with semantic strong/headings at 600. Table text and body numbers inherit the reply weight; inline/block code stays monospaced at 400. This supersedes the earlier unchanged-weight statement; toolbar metadata and UI font sizes stay independent.

Feature commit: `852ec89a`. Dev integration build: `adba86295fa5f76da87ad8da6e41aaf658b3483f`. Signed `scripts/build_lake_desktop.sh --dev --install`, TypeScript/Vite, deep/strict codesign and diff checks passed; all 9 existing assistant-prose regressions passed. No new test was added for the CSS adjustment.

The existing Markdown fixture was inspected in light desktop and 430 px dark views with no horizontal overflow. Computed body/strong/headings/table/code weights are 500/600/600/500/400. Platform-font inspection confirms actual PingFang SC Medium and Semibold glyphs, alongside system SF glyphs. Light body is rgb(13,13,13), dark body rgb(238,238,238). Screenshots: `/tmp/lake-prose-weight-light.png`, `/tmp/lake-prose-weight-dark-narrow.png`. Browser task 30 finished and the isolated Vite fixture server was stopped.

Native UI access returned `timeoutReached` three times, including a fresh application lookup. The package is installed, but restarting the currently running Lake Dev and native acceptance of this weight change remain manual. No production app or data was accessed. No remote write.

Installed backend SHA-256: `eaee507c23cba23a9ddba6a34b15b8098b15b8e9b429879f4d10336391ce3e7d`.
