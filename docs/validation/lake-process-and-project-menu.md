# Conversation process and sidebar controls

Date: 2026-10-14 (Asia/Shanghai).

Tool process capsules are replaced by muted, borderless action descriptions with a disclosure arrow. Summaries retain concrete filenames and targets; recognizable command categories describe system/resource checks, service checks, process/connection checks and database commands without displaying raw command contents. Quoted text and comments do not trigger classification. Details retain parameters, output and individual operation states. Raw reasoning remains collapsed. Independent agent tasks and todo progress also start collapsed; pending agent approvals remain visible.

Each turn has a single final state/time row, after replies, file changes and todo progress. It transitions through thinking, tools, streaming, approval/user input and completion, with a small warm animated mark during active processing. Approval pauses the animation. Completed and cancelled durations stay frozen; stored completion wins over a stale running snapshot. Old pending cards and foreign/older agent runs cannot become current progress, and activity filtering does not borrow a newer hidden turn's state. Elapsed seconds do not repeatedly announce through the live region; only phase changes do. Unknown endpoints never fabricate elapsed time. Session cumulative tokens are not mislabeled as turn usage.

The native project select is replaced by an application-styled menu with an explicit checked current project. It supports arrow-key opening/navigation, selection, outside dismissal and Escape focus restoration. Selecting the current project preserves the current chat. Session/resource headings use the same 13px label and 11px count; folder labels/counts match the sidebar hierarchy, and add icons are 16px.

Validation: TypeScript, all 120 frontend tests, the signed Dev build and strict signature verification pass. Live fixture rendering exercised thinking/tool/approval/completion phases, expandable tool output, final-child placement and a 390px viewport without overflow. Actual installed rendering confirmed no native select, both headings at 13px, custom menu selection and no browser errors. Actual session footers were final children with 32秒 · 已完成, 22秒 · 已停止 and 54秒 · 已完成. The 390px project menu stayed inside viewport bounds; Escape restored trigger focus.

Only Lake Dev was replaced and restarted. The previous signed bundle is retained at ~/Library/Application Support/Lake Dev/builds/Lake-Dev-before-project-menu-66708e15.app. The release backend remained PID 65427 on port 49288. No conversations or resources were created, moved or deleted by verification, and no model calls were issued for tests. Temporary fixture files, tabs, viewport overrides and Vite servers were cleaned up.

Screenshots:
- /Users/lingyunxieqing/.codex/visualizations/2026/10/12/01a12eda-1990-7ee3-818b-d065e5298b1c/lake-dev-project-menu.png
- /Users/lingyunxieqing/.codex/visualizations/2026/10/12/01a12eda-1990-7ee3-818b-d065e5298b1c/lake-dev-process-footer.png
