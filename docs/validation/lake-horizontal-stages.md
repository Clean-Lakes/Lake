> 展示方案已由 [DeepSeek 风格思考时间线](lake-thinking-timeline.md) 替代；以下保留原验证记录。

# Compact conversation stages

Completed 2026-10-11. Context-compaction notification cards are excluded from the visible transcript, including loaded older pages; automatic compaction and stored history remain intact.

Consecutive thinking/tool/background-command stages appear as horizontal disclosure buttons with wrapping for available width. Adjacent tool calls form one operation-set button. Opening a button shows multiline details below the full stage strip; several panels can stay open. Expansion pauses automatic scroll-following so the opened stage stays visible. Replies, user messages and native approval cards break stage groups, preserving their original order and conversation turn.

Validation: React type check/production build passed; four frontend timeline tests passed, including compaction exclusion, turn/reply boundaries and old-approval placement. The signed binary passed signature verification and the no-Node runtime check. A private local fixture verified the collapsed horizontal row, two simultaneous expanded panels, multiline content, hidden compaction notice and stable scroll position. No model calls or production-data edits were used for browser verification.

![Collapsed stage row](lake-horizontal-stages.png)

![Multiple expanded stages](lake-horizontal-stages-expanded.png)
