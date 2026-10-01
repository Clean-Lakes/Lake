import type { LakeCLIContext } from "../../domain/cli.js";
import type { LakeRuntime } from "../../domain/protocol.js";
import { object } from "../../domain/validation.js";
import { readSettings } from "../config/files.js";
import { FileVault } from "../vault.js";
import { flag, type Arguments } from "./arguments.js";
import { readSecret } from "./secret-input.js";

export async function mcpCommand(
  context: LakeCLIContext,
  runtime: LakeRuntime,
  args: Arguments,
  root: string,
) {
  const [, action, name] = args.positionals,
    settings = await readSettings(root),
    server = (settings.mcp as Record<string, unknown>[]).find((item) => item.name === name);
  if (!server) throw new Error("MCP 服务未登记");
  if (action === "test")
    return runtime.dispatch({ method: "settings", params: { action: "mcp_test", name } });
  if (action === "logout") {
    await new FileVault(root).delete("mcp", name);
    return null;
  }
  if (action !== "login")
    throw new Error(
      "用法：lake mcp login <名称> --env <变量名> 或 --header <请求头名>；值从隐藏输入或 stdin 读取",
    );
  const env = flag(args, "env"),
    header = flag(args, "header");
  if (!env === !header) throw new Error("请指定一个 --env 或 --header");
  const bytes = await readSecret(context, env || header);
  try {
    const value = bytes.toString("utf8").trim();
    if (!value || /[\r\n]/.test(value)) throw new Error("凭据不能为空或含换行");
    const vault = new FileVault(root),
      previous = (await vault.has("mcp", name)) ? await vault.load("mcp", name) : Buffer.from("{}");
    let existing;
    try {
      existing = object(JSON.parse(previous.toString()));
    } finally {
      previous.fill(0);
    }
    return await runtime.dispatch({
      method: "settings",
      params: {
        action: "mcp_save",
        server: {
          ...server,
          ...(env
            ? { env: { ...object(existing.env), [env]: value } }
            : { headers: { ...object(existing.headers), [header]: value } }),
        },
      },
    });
  } finally {
    bytes.fill(0);
  }
}
