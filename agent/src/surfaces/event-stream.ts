import type { ServerResponse } from "node:http";
import type { LakeApplication } from "../app/application.js";
export async function streamEvents(
  app: LakeApplication,
  sessionId: string,
  after: string,
  response: ServerResponse,
): Promise<void> {
  let closed = false;
  response.on("close", () => {
    closed = true;
  });
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
  });
  let cursor = after;
  while (!closed) {
    const events = await app.events.replay(`session:${sessionId}`, cursor);
    for (const event of events) {
      if (closed) return;
      const ready = response.write(
        `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`,
      );
      cursor = event.sequence;
      if (!ready)
        await new Promise<void>((resolve) => {
          response.once("drain", resolve);
          response.once("close", resolve);
        });
    }
    if (!events.length) {
      response.write(": heartbeat\n\n");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
