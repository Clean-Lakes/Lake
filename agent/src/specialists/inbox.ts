import type { StorePort } from "../domain/ports.js";
import { changeCommands } from "../domain/events.js";
export class InboxService {
  constructor(private readonly store: StorePort) {}
  async history(
    actor: string,
  ): Promise<{ id: string; revision: number; text: string }[]> {
    return (await this.store.list<any>("specialist_inbox")).filter(
      (m) => m.actor === actor,
    );
  }
  async deliver(
    sessionId: string,
    actor: string,
    text: string,
    id: string,
  ): Promise<void> {
    if (await this.store.get("specialist_inbox", id)) return;
    const value = {
      id,
      revision: 1,
      sessionId,
      actor,
      text,
      acknowledged: false,
      createdAt: new Date().toISOString(),
    };
    await this.store.transact(
      changeCommands(
        "specialist_inbox",
        value,
        "specialist.message_received",
        actor,
        new Date().toISOString(),
      ),
    );
  }
  async pending(actor: string): Promise<
    {
      id: string;
      revision: number;
      text: string;
    }[]
  > {
    return (await this.store.list<any>("specialist_inbox")).filter(
      (m) => m.actor === actor && !m.acknowledged,
    );
  }
  async ack(ids: string[]): Promise<void> {
    for (const id of ids) {
      const row = await this.store.get<any>("specialist_inbox", id);
      if (row && !row.acknowledged)
        await this.store.transact([
          {
            op: "put",
            table: "specialist_inbox",
            value: { ...row, revision: row.revision + 1, acknowledged: true },
            expectedRevision: row.revision,
          },
        ]);
    }
  }
}
