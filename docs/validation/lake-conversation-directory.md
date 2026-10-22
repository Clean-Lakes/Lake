# Conversation directory and inset

Date: 2026-10-14 (Asia/Shanghai).

- The desktop session gutter increases from 24px to 40px, moving the title, properties, transcript and composer 16px right while retaining the fixed left anchor. Mobile uses 32px to reserve a small rail for the directory button.
- A miniature rail opens a compact conversation directory. Each loaded directory entry has one horizontal mark; marks are not a fixed icon. The reading position determines the current mark, rendered darker and longer, with the same mark and highlight in the popup list. The compact rail is bounded to 128px and compresses spacing for long histories while retaining every mark. It lists actual user questions, distinguishes repeated questions through accessible turn numbers, and jumps to the corresponding turn. “Jump to latest” returns to the bottom. Opening or navigating pauses automatic following so the user's chosen position is retained.
- The directory starts closed, dismisses on an outside click or Escape, and restores focus after selecting a question. Its list scrolls within the available conversation area; the footer remains visible. Narrow panes constrain the popup width and height. The rail retains a nonzero control box for native accessibility while negative margins preserve transcript spacing.
- Entries refer only to rendered turns. If earlier cards are paginated, the same existing load-older operation is available in the directory. Session-scoped anchors prevent collisions when switching conversations. The activity tab uses the same anchors, restricted to its visible turns; evidence retains its existing layout.

TypeScript and 114 frontend regressions pass, including duplicate questions, unloaded turns, attachment-only messages, targets in both conversation/activity modes, growing mark counts and active-entry changes in both scroll directions. The signed macOS Dev production build and strict signature checks pass.

Actual browser checks: the current history has 11 directory entries and exactly 11 rail marks; selecting turn 2 highlights mark 2 and its list entry. Inactive marks measure 10×2px, the active mark 18×2px. Direct clicks preserve the reading position; the popup scrolls its active entry into view. Selecting turn 2 placed its question 16px below the conversation viewport top. Latest navigation and Escape dismissal work. At 1600px window width, header, transcript and composer remain 40px from the pane's left edge. At 390px, the open directory fits inside the conversation area with no horizontal overflow. Browser error logs are empty; no model requests or new conversation messages were sent.

Only Lake Dev is installed and restarted; its previous bundle is preserved. The release application remains independent.
