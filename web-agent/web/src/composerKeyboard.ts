export type SendShortcut = "enter" | "command-enter";
export const sendShortcutStorageKey = "lake.send-shortcut";

export function parseSendShortcut(value: string | null): SendShortcut {
  return value === "command-enter" ? value : "enter";
}

type ComposerKey = {key: string; isComposing?: boolean; keyCode?: number; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; repeat?: boolean};

/** Some IMEs end composition before dispatching the confirming Enter key. */
export class CompositionGuard {
  private active = false;
  private endedAt = -Infinity;
  start() { this.active = true; }
  end(now = performance.now()) { this.active = false; this.endedAt = now; }
  ignores(event: ComposerKey, now = performance.now()) {
    return this.active || event.isComposing === true || event.keyCode === 229 || event.key === "Enter" && now - this.endedAt < 50;
  }
}

export function isSendKey(event: ComposerKey, shortcut: SendShortcut) {
  if (event.key !== "Enter" || event.isComposing || event.keyCode === 229 || event.shiftKey || event.altKey || event.repeat) return false;
  return shortcut === "command-enter" ? !!(event.metaKey || event.ctrlKey) : !event.metaKey && !event.ctrlKey;
}
