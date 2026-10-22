# Conversation tag colors

Date: 2026-10-14 (Asia/Shanghai).

- Sidebar conversations show their assigned tags below the title, with the same palette as the page header. At most two tag names are visible; additional names are available in the accessible label and count tooltip. Narrow rows wrap instead of squeezing short tag names.
- Assistant reply cards (both Go `message` and older `text` cards) decorate matching tag names in Markdown prose, including headings, emphasis and tables. Matching is case insensitive; longer tag names take precedence. Only the current session's assigned tags apply.
- Code blocks, inline code, links, image nodes, HTML and English identifiers/paths remain intact. The persisted answer text is unchanged. Removing, renaming or recoloring tags updates existing replies; the card memo comparator includes tag identity, name and color.
- TypeScript, 110 frontend tests, the signed macOS Dev build and strict signature verification passed. Regression coverage exercises actual Go reply types, Markdown protection, overlapping and regex-like names, reassignment and compact accessible sidebar tags.
- Browser inspection of the actual Dev history found 21 decorated mentions. Their foreground and background colors matched the corresponding header/sidebar colors. No new conversation messages or remote model calls were generated for validation.

Only Lake Dev is updated. The separate release application is preserved.
