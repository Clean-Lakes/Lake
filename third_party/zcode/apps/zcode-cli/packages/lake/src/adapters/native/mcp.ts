import { join } from "node:path";
import { createMcpAdapter } from "@zcode/adapters/mcp";
import { object, text, type Params } from "../../domain/validation.js";
import { prepareNativeExtensions } from "../agent/extensions.js";
import type { FileVault } from "../vault.js";

export async function testNativeMCP(root: string, vault: FileVault, name: string): Promise<Params> {
  const extensions = await prepareNativeExtensions(
      root,
      join(root, "zcode-runtime", "extension-discovery"),
      vault,
      process.cwd(),
    ),
    server = extensions.mcp.find((server) => server.name === name);
  if (!server) throw new Error("MCP 服务未登记或未启用");
  const values = (array: unknown) =>
    Object.fromEntries(
      (Array.isArray(array) ? array : []).map((item) => {
        const pair = object(item);
        return [text(pair, "name"), text(pair, "value")];
      }),
    );
  const adapter = createMcpAdapter({ workingDirectory: process.cwd() });
  const config: Parameters<typeof adapter.connectServer>[1] = server.command
    ? {
        type: "stdio",
        command: text(server, "command"),
        args: server.args as string[],
        env: values(server.env),
        protocolVersion: "legacy",
        timeoutMs: 15000,
      }
    : {
        type: "http",
        url: text(server, "url"),
        headers: values(server.headers),
        protocolVersion: "legacy",
        timeoutMs: 15000,
      };
  try {
    const status = await adapter.connectServer(name, config);
    if (status.status !== "connected") throw new Error("MCP 连接失败，请检查地址、命令与凭据");
    return { tools: (await adapter.listTools()).map((tool) => tool.toolName) };
  } finally {
    await adapter.close();
  }
}
