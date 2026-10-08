import { randomUUID } from "node:crypto";
import type { StorePort } from "../domain/ports.js";
import type { ExecutionSession } from "../domain/entities.js";
import { requireCondition, LakeError } from "../domain/errors.js";
import { changeCommands } from "../domain/events.js";
interface RedactionStream {
  push(text: string): string;
  flush(): string;
}
export class TerminalOutput {
  private readonly streams = new Map<string, RedactionStream>();
  constructor(
    private readonly store: StorePort,
    private readonly sanitize: (text: string) => string,
    private readonly createStream?: () => RedactionStream,
  ) {}
  async appendStreamOutput(id: string, text: string): Promise<void> {
    if (!this.createStream) {
      await this.appendOutput(id, text);
      return;
    }
    let stream = this.streams.get(id);
    if (!stream) {
      stream = this.createStream();
      this.streams.set(id, stream);
    }
    const safe = stream.push(text);
    if (safe) await this.appendOutput(id, safe);
  }
  async finishStream(id: string): Promise<void> {
    const stream = this.streams.get(id);
    this.streams.delete(id);
    if (stream) {
      const safe = stream.flush();
      if (safe) await this.appendOutput(id, safe);
    }
  }
  async appendOutput(
    id: string,
    text: string,
    actionId?: string,
  ): Promise<void> {
    text = this.sanitize(text).slice(0, 65536);
    for (let attempt = 0; attempt < 10; attempt++) {
      const t = await this.store.get<ExecutionSession>(
        "execution_sessions",
        id,
      );
      requireCondition(t, "not_found");
      const cursor = (BigInt(t.outputCursor) + 1n).toString();
      const chunk = {
        id: randomUUID(),
        revision: 1,
        sessionId: t.sessionId,
        terminalSessionId: id,
        cursor,
        text,
        actionId: actionId ?? null,
        createdAt: new Date().toISOString(),
      };
      const value = { ...t, revision: t.revision + 1, outputCursor: cursor };
      try {
        await this.store.transact([
          {
            op: "put",
            table: "terminal_chunks",
            value: chunk,
            expectedRevision: 0,
          },
          ...changeCommands(
            "execution_sessions",
            value,
            "terminal.output",
            "system",
            new Date().toISOString(),
          ),
        ]);
        return;
      } catch (e) {
        if (!(e instanceof LakeError && e.code === "conflict")) throw e;
      }
    }
    throw new LakeError("conflict");
  }
}
