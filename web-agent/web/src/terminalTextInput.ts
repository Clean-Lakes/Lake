/** Recover committed punctuation that WebKit delivers only through input.
 * xterm still owns keys, paste and IME composition. Never infer a character
 * from a physical key code or translate a Chinese punctuation mark to ASCII.
 */
export class TerminalTextInput {
  private handled = false;
  private composing = false;
  private finishing = false;
  private pending: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private compositionTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly send: (text: string) => void) {}

  keydown() { this.flush(); this.handled = false; }
  keyup() { this.handled = false; }
  compositionStart() { this.flush(); this.composing = true; }
  compositionEnd() {
    this.composing = false;
    this.finishing = true;
    clearTimeout(this.compositionTimer);
    // xterm commits composition asynchronously after compositionend.
    this.compositionTimer = setTimeout(() => { this.finishing = false; this.handled = false; }, 0);
  }
  data(text: string) {
    if (this.pending === text) this.cancelPending();
    else this.flush();
    this.handled = true;
    this.send(text);
  }
  input(event: Pick<InputEvent, "data" | "inputType" | "isComposing">) {
    const handled = this.handled;
    this.handled = false;
    if (handled || this.composing || this.finishing || event.isComposing || event.inputType !== "insertText" || !event.data || !/^[\p{P}\p{S}\p{Zs}]+$/u.test(event.data)) return;
    this.flush();
    this.pending = event.data;
    // Give xterm's keyCode=229 fallback a chance to emit first, without
    // duplicating it; flush before the next key/data to preserve input order.
    this.timer = setTimeout(() => this.flush(), 0);
  }
  private cancelPending() { clearTimeout(this.timer); this.timer = undefined; this.pending = undefined; }
  private flush() {
    const text = this.pending;
    this.cancelPending();
    if (text !== undefined) this.send(text);
  }
  dispose() { this.cancelPending(); clearTimeout(this.compositionTimer); }
}

export function usesWebKitTextInput(platform: string, userAgent: string): boolean {
  return /Mac/.test(platform) && /AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg|OPR/.test(userAgent);
}
