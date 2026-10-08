import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
export async function startModelFixture(
  reply: (
    body: any,
    attempt: number,
  ) => {
    text?: string;
    calls?: {
      id: string;
      name: string;
      arguments: string;
    }[];
    partial?: boolean;
    status?: number;
  },
) {
  let attempts = 0;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (raw.length > 1048576) {
      res.writeHead(413).end();
      return;
    }
    const input = JSON.parse(raw),
      result = reply(input, ++attempts);
    if (result.status) {
      res.writeHead(result.status).end();
      return;
    }
    const toolCalls = (result.calls ?? []).map((c, index) => ({
      index,
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.arguments },
    }));
    if (input.stream === false) {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: result.text ?? null,
                tool_calls: toolCalls.map(({ index, ...r }) => r),
              },
              finish_reason: toolCalls.length ? "tool_calls" : "stop",
            },
          ],
          usage: { prompt_tokens: 30, completion_tokens: 10 },
        }),
      );
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    const delta = { content: result.text ?? "", tool_calls: toolCalls };
    let output = `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    if (!result.partial)
      output += `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 30, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`;
    const bytes = Buffer.from(output);
    for (let i = 0; i < bytes.length; i += 3)
      res.write(bytes.subarray(i, i + 3));
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    get attempts() {
      return attempts;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
