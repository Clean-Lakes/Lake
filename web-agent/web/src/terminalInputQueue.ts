type Input = { session: string; terminal: string; data: string; bytes: number };

/** Keep PTY input ordered while combining keystrokes typed during a request. */
export class TerminalInputQueue {
  private pending: Input[] = [];
  private sending = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly encoder = new TextEncoder();

  constructor(private readonly send: (session: string, terminal: string, data: string) => Promise<unknown>, private readonly onError: (error: unknown) => void) {}

  enqueue(session: string, terminal: string, data: string): void {
    if (!data) return;
    let chunk = "", bytes = 0;
    for (const char of data) {
      const size = this.encoder.encode(char).length;
      if (bytes + size > 4096) {
        this.pending.push({ session, terminal, data: chunk, bytes });
        chunk = ""; bytes = 0;
      }
      chunk += char; bytes += size;
    }
    if (chunk) this.pending.push({ session, terminal, data: chunk, bytes });
    if (this.sending) return;
    if (/[\x00-\x1f\x7f]/.test(data)) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 8);
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.sending || !this.pending.length) return;
    this.sending = true;
    void this.drain();
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      const first = this.pending.shift()!;
      let data = first.data, bytes = first.bytes;
      while (this.pending.length && this.pending[0]!.session === first.session && this.pending[0]!.terminal === first.terminal && bytes + this.pending[0]!.bytes <= 4096) {
        const next = this.pending.shift()!;
        data += next.data; bytes += next.bytes;
      }
      try { await this.send(first.session, first.terminal, data); }
      catch (error) {
        this.pending = this.pending.filter(item => item.session !== first.session || item.terminal !== first.terminal);
        this.onError(error);
      }
    }
    this.sending = false;
  }
}
