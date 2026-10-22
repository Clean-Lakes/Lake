# Rounded composer strip

Date: 2026-10-14 (Asia/Shanghai).

- The message field is a single rounded surface with a return-arrow send button inside its right edge. Attachments, references and image previews stay inside this surface. The stop and queued-send actions retain their existing behavior and remain associated with the same form.
- The toolbar sits below the field. Its attachment button is an accessible plus icon; the permission entry opens the existing configuration without changing stored permissions. Model selection is a plain text control. The context ring retains its actual measured usage and detailed popup; its percentage text is visually hidden in this compact variant.
- The Agent identity row is removed from the input dock. A 40px theme-aware, pointer-transparent gradient fades the bottom of the conversation into the dock. Existing fixed left alignment and maximum reading width remain.

TypeScript, 114 frontend regressions, the signed macOS Dev production build and strict signature verification pass. Actual browser checks found a 56px empty input surface, footer outside the border, and send control inside it. Five lines grew the field to 140px without sending a message. The textarea and submit control belong to the same form. Permission and context detail popups were opened successfully without changing settings.

At 390px viewport width, the input surface is 52px high, all toolbar/send controls fit within the composer, and the document has no horizontal overflow. Browser error logs are empty. The temporary draft was cleared and the viewport reset. No model calls or new conversation messages were generated.

Only Lake Dev is installed and restarted; the previous bundle is retained. The release application stays independent.
