import { authHeaders } from "./client";
export interface ClientEvent {
  eventId: string;
  sequence: string;
  type: string;
  aggregateId: string;
  aggregateRevision: number;
  actor: string;
  data: Record<string, any>;
}
export class EventClient {
  async subscribe(
    sessionId: string,
    after: string,
    onEvent: (event: ClientEvent) => Promise<string | void>,
    signal: AbortSignal,
  ): Promise<void> {
    let cursor = after;
    while (!signal.aborted) {
      try {
        const response = await fetch(
          `/api/v1/sessions/${sessionId}/events?after=${cursor}`,
          { headers: authHeaders(), signal },
        );
        if (!response.ok || !response.body) throw new Error("事件连接失败");
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        let pending = "";
        try {
          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true });
            let end;
            while ((end = pending.indexOf("\n\n")) >= 0) {
              const block = pending.slice(0, end);
              pending = pending.slice(end + 2);
              const line = block
                .split("\n")
                .find((l) => l.startsWith("data: "));
              if (line) {
                const event = JSON.parse(line.slice(6)) as ClientEvent;
                const next = await onEvent(event);
                if (next && BigInt(next) > BigInt(cursor)) cursor = next;
                else if (BigInt(event.sequence) > BigInt(cursor))
                  cursor = event.sequence;
              }
            }
          }
        } finally {
          try {
            await reader.cancel();
          } catch {}
          reader.releaseLock();
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
