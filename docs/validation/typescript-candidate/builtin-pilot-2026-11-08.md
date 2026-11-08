# Built-in Pilot navigation

Tested clean source: `4594c0129cacfb2a568b431ff5acd5546069d6cc`, PR #199 to `develop`.

Pilot is now the first row in the specialist group, with the visible “话事人” badge, its original coordinator avatar and “对话与任务统筹” subtitle. The group count includes Pilot. The compact brand header retains only Lake, Dev and independent search. Pilot has no deletion menu; its row still opens the original project router session. No extra role/channel, copied history or execution identity was created.

The row preserves exact-session work animation, pending confirmation and unread precedence. Workspace activation keeps the Pilot entry and actual error visible. Deleting a normal specialist still returns focus to the Pilot row; normal specialist management is retained.

## Verification

- Frontend type check and web production build passed.
- Frontend suite: **762 passed**, no failures or skips.
- Rebuilt TypeScript bundle, then ran the two selected server regressions: built-in Pilot session/role deletion rejection and ordinary specialist retirement. **2 passed**. The first test verifies that the original router/history survive both deletion API paths and no model turn starts. The full backend suite was not rerun for this UI relocation.
- ADK runtime boundary check passed; `git diff --check` passed.
- Signed Dev build/install: `scripts/build_lake_desktop.sh --dev --ts-candidate --install`. Provenance reports the tested SHA, clean source and TypeScript backend. Backend SHA256: `0cb3b83f4a82a13e8a6202a2fbf1b642f87bccc0493c460866f26e8aad49b3d7`. Deep/strict code-signature verification passed with `Lake Local Development Code Signing`.
- Native light/dark checks at approximately 1109 × 788 and 1024 × 727 logical points: Pilot first, readable badge, same selected/hover/focus contour and aligned rows; five entries for Pilot plus four existing specialists.
- Clicking Pilot opened the same pre-existing router session. Right-click offered no delete action; a normal specialist still offered “删除专员”. No delete action was submitted in the real Dev home.
- Search remains separate and usable. Tab reaches Pilot and Enter opens its original destination; the narrow dark view showed a complete focus outline without clipping.
- Restored the original light theme, window size and specialist channel after verification. No model turn or resource operation was initiated.

Read-only baseline hashes of `superProjects`, `superRoles`, `superChannels`, `superGoals`, `superOperations`, `superAcceptance` and `superDecisions` were compared after verification. Private history, document URLs, authentication details and screenshots are not committed. Only Lake Dev was installed/restarted; production installation was not changed.
