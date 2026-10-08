import { publicProjection } from "../domain/schemas.js";
export class Redactor {
  private readonly values = new Set<string>();
  register(value: string): void {
    this.retain(value);
    for (const match of value.matchAll(
      /(?:["']?(?:token|api[_-]?key|access[_-]?token|password|passwd|secret|client-key-data)["']?)\s*[:=]\s*["']?([^\s"',;}]+)/gi,
    ))
      if (match[1] && match[1] !== "[REDACTED]") this.retain(match[1]);
    if (value.trim().startsWith("{"))
      try {
        const pending: unknown[] = [JSON.parse(value)];
        let visited = 0;
        while (pending.length && visited++ < 10000) {
          const item = pending.pop();
          if (item && typeof item === "object")
            for (const [key, child] of Object.entries(item)) {
              if (
                /^(password|passwd|api[_-]?key|access[_-]?token|private[_-]?key|secret|passphrase)$/i.test(
                  key,
                ) &&
                typeof child === "string"
              )
                this.retain(child);
              else if (child && typeof child === "object") pending.push(child);
            }
        }
      } catch {}
  }
  private retain(value: string): void {
    if (value.length >= 4) this.values.add(value);
    for (const line of value.split(/\r?\n/))
      if (line.length >= 16) this.values.add(line);
  }
  needles(): string[] {
    return [...this.values].sort((a, b) => b.length - a.length);
  }
  text(text: string): string {
    for (const value of this.needles())
      text = text.split(value).join("[REDACTED]");
    return text;
  }
  private discover(text: string): void {
    for (const match of text.matchAll(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    ))
      this.register(match[0]);
    for (const match of text.matchAll(
      /(?:["']?(?:api[_-]?key|access[_-]?token|password|passwd|secret|requirepass)["']?)\s*[:=]\s*["']?([^\s"',;}]+)/gi,
    ))
      if (match[1] && match[1] !== "[REDACTED]") this.register(match[1]);
  }
  value(value: unknown): unknown {
    const scan = (item: unknown): void => {
      if (typeof item === "string") this.discover(item);
      else if (Array.isArray(item)) item.forEach(scan);
      else if (item && typeof item === "object")
        Object.values(item).forEach(scan);
    };
    scan(value);
    return JSON.parse(
      this.text(JSON.stringify(publicProjection(value)) ?? "null"),
    );
  }
}
export class StreamingRedactor {
  private pending = "";
  private privateKey = false;
  constructor(private readonly redactor: Redactor) {}
  push(chunk: string): string {
    this.pending += chunk;
    if (this.privateKey) {
      const end = /-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/.exec(
        this.pending,
      );
      if (!end) {
        this.pending = this.pending.slice(-128);
        return "";
      }
      this.pending = this.pending.slice(end.index + end[0].length);
      this.privateKey = false;
      return this.push("");
    }
    const begin = this.pending.indexOf("-----BEGIN "),
      header =
        begin >= 0
          ? /^-----BEGIN ([A-Z ]+)-----/.exec(this.pending.slice(begin))
          : null;
    if (header && /PRIVATE KEY(?: BLOCK)?$/.test(header[1]!)) {
      const prefix = this.pending.slice(0, begin),
        body = this.pending.slice(begin + header[0].length);
      this.pending = prefix;
      const safe = this.flush();
      this.privateKey = true;
      this.pending = body;
      return safe + "[REDACTED_PRIVATE_KEY]" + this.push("");
    }
    const needles = this.redactor.needles();
    let cut = this.pending.length;
    if (begin >= 0 && !header) cut = Math.min(cut, begin);
    const marker = "-----BEGIN ";
    for (let n = 1; n < marker.length && n <= this.pending.length; n++)
      if (this.pending.endsWith(marker.slice(0, n)))
        cut = Math.min(cut, this.pending.length - n);
    for (const value of needles) {
      for (let n = 1; n < value.length && n <= this.pending.length; n++) {
        if (this.pending.endsWith(value.slice(0, n)))
          cut = Math.min(cut, this.pending.length - n);
      }
      for (
        let at = this.pending.indexOf(value);
        at >= 0;
        at = this.pending.indexOf(value, at + 1)
      )
        if (at < cut && at + value.length > cut) cut = at;
    }
    const out = this.redactor.text(this.pending.slice(0, cut));
    this.pending = this.pending.slice(cut);
    return out;
  }
  flush(): string {
    if (this.privateKey) {
      this.pending = "";
      this.privateKey = false;
      return "";
    }
    if (this.pending.startsWith("-----BEGIN ")) {
      this.pending = "";
      return "[REDACTED_PARTIAL]";
    }
    const partial = this.redactor
      .needles()
      .some(
        (value) =>
          this.pending.length > 0 &&
          this.pending.length < value.length &&
          value.startsWith(this.pending),
      );
    const out = partial
      ? "[REDACTED_PARTIAL]"
      : this.redactor.text(this.pending);
    this.pending = "";
    return out;
  }
}
