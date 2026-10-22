# Fixed left alignment for session content

Date: 2026-10-14 (Asia/Shanghai).

Session page properties, transcript content, loading/empty states, composer identity, input box and queued messages now use a left anchor instead of automatic centering. A shared `--session-gutter` keeps the left inset consistent; existing maximum reading widths remain. Tabs use the same horizontal inset.

Verified against the actual signed Dev backend in the browser:

| Window width | Main pane width | Header / transcript / composer / identity left inset | Horizontal overflow |
| --- | --- | --- | --- |
| 1100px | 850px | 24px | None |
| 1600px | 1350px | 24px | None |
| 1600px, widened sidebar | 1250px | 24px | None |
| 390px | 390px | 13px | None |

The execution-record view was also checked after resizing the sidebar. Browser errors were empty. Temporary viewport overrides were reset and the verification tab was closed. The native Dev app was restarted and returned to the user's execution-record view. TypeScript, the production build and strict signature verification passed. This change only adjusts layout CSS; no new unit tests were added.

The previous Dev bundle is retained in the local builds directory. The release backend keeps its original PID and remains healthy.
