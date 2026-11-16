import type {Model} from './sdk';

type StreamEvent = ReturnType<Model['streamText']> extends AsyncIterable<infer Event> ? Event : never;
const begin = '-----BEGIN ', end = '-----END ';
const privateHeader = /^-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const privateFooter = /^-----END [A-Z ]*PRIVATE KEY-----/;
function partialMarker(value: string, prefix: string) {
  if (value.length < prefix.length) return prefix.startsWith(value);
  // All capital letters/spaces can still be a PEM label. Once its trailing
  // dashes begin, only an incomplete PRIVATE KEY delimiter can remain valid.
  return value.startsWith(prefix) && /^[A-Z ]*(?:PRIVATE KEY-{1,4})?$/.test(value.slice(prefix.length));
}

/** Retain only an ambiguous credential/PEM prefix, never a fixed text tail. */
class StreamTextRedactor {
  private pending = '';
  private inPrivateKey = false;
  constructor(private readonly secrets: Iterable<string>) {}
  push(delta: string, final = false) {
    const text = this.pending + delta;
    const secrets = [...this.secrets].filter(Boolean);
    this.pending = '';
    let output = '', at = 0;
    while (at < text.length) {
      const rest = text.slice(at);
      if (this.inPrivateKey) {
        const footer = rest.match(privateFooter);
        if (footer) { at += footer[0].length; this.inPrivateKey = false; continue; }
        if (!final && rest[0] === '-' && partialMarker(rest, end)) { this.pending = rest; break; }
        at++; // Discard private key bytes instead of accumulating the body.
        continue;
      }
      const header = rest[0] === '-' ? rest.match(privateHeader) : null;
      if (header) { output += '[PRIVATE KEY REDACTED]'; at += header[0].length; this.inPrivateKey = true; continue; }
      let match = '', partial = false;
      for (const secret of secrets) {
        if (secret[0] !== rest[0]) continue;
        if (rest.startsWith(secret) && secret.length > match.length) match = secret;
        else if (!final && secret.startsWith(rest)) partial = true;
      }
      if (!final && (partial || rest[0] === '-' && partialMarker(rest, begin))) { this.pending = rest; break; }
      if (match) { output += '[REDACTED]'; at += match.length; }
      else output += text[at++];
    }
    return output;
  }
}

/** Each text, reasoning and tool-input channel owns its own incomplete prefix.
 * An unrelated end event cannot release another channel's credential bytes. */
export async function* redactModelStream(events: AsyncIterable<StreamEvent>, secrets: Iterable<string>, scrub: <T>(value: T) => T): AsyncGenerator<StreamEvent> {
  const channels = new Map<string, {redactor: StreamTextRedactor; event: Record<string, any>; field: string}>();
  const currentIds = new Map<string, string>();
  const keyFor = (event: Record<string, any>, type: string) => JSON.stringify([type, event.id ?? event.toolCallId ?? currentIds.get(type.replace(/_delta$/, '')) ?? '']);
  const flush = function* (key?: string) {
    for (const [id, item] of channels) {
      if (key !== undefined && key !== id) continue;
      const text = item.redactor.push('', true);
      if (text) yield scrub({...item.event, [item.field]: text}) as StreamEvent;
      channels.delete(id);
    }
  };
  for await (const event of events) {
    const raw = event as Record<string, any>, type = String(raw.type);
    if (type.endsWith('_start') && raw.id !== undefined) currentIds.set(type.slice(0, -6), raw.id);
    const field = typeof raw.text === 'string' ? 'text' : typeof raw.delta === 'string' ? 'delta' : undefined;
    if (field && type.endsWith('_delta')) {
      const key = keyFor(raw, type);
      const channel = channels.get(key) ?? {redactor: new StreamTextRedactor(secrets), event: raw, field};
      channel.event = raw; channel.field = field; channels.set(key, channel);
      const text = channel.redactor.push(raw[field]);
      if (text) yield scrub({...raw, [field]: text}) as StreamEvent;
    } else {
      if (type.endsWith('_end')) {
        yield* flush(keyFor(raw, type.replace(/_end$/, '_delta')));
        currentIds.delete(type.slice(0, -4));
      } else if (type === 'finish') yield* flush();
      else if (type === 'error') channels.clear();
      yield scrub(event);
    }
  }
  yield* flush();
}
