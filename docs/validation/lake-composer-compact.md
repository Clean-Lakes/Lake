# Compact composer and simpler navigation

Date: 2026-10-14 (Asia/Shanghai).

- The composer starts at approximately 96px high, with a 38px textarea. Textarea height follows content and width changes, up to 160px, then scrolls. Five short lines produced a 165px composer in the isolated browser check.
- Attachment, permission, context, model and send controls have consistent compact sizes. The active model shows its final name segment; its full identifier remains in the tooltip and accessible label. Context usage retains its actual value and now has a readable progress arc.
- The footer uses a container query to reflow when the middle pane is narrow, including beside a terminal. At 760px viewport width, the 463.7px composer used the compact grid. At 390px viewport width, all controls remained inside the 364px composer and the document had no horizontal overflow.
- The project memory navigation row and project context-menu entry were removed. Configuration is available under **Settings → Dialogue → Configure project memory**. This route was opened and verified against an isolated project.
- Native Dev chrome no longer reserves the release updater's empty 72px space; its refresh button sits at a 16px right inset. Release chrome retains its required updater space.

TypeScript, 106 frontend regressions, the production desktop build and strict persistent-identity signature verification passed. Browser error logs were empty. Installed and restarted only `Lake Dev.app`, preserving the previous bundle. Release backend health and PID were unchanged.

![Mobile layout with fictional project and model configuration](lake-composer-compact-mobile.jpg)
