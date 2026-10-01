import { homedir } from "node:os";
import { join } from "node:path";
import type { LakeCLIContext } from "../../domain/cli.js";
import type { JsonValue } from "../../domain/json.js";
import { object, redact, text, type Params } from "../../domain/validation.js";
import { createLakeRuntime } from "../runtime.js";
import { parseArguments, flag, readRequest } from "./arguments.js";
import { runBridge } from "./bridge.js";
import { resourceCommand } from "./resources.js";
import { modelCommand } from "./models.js";
import { workflowCommand } from "./workflows.js";

export async function runLakeCLI(context: LakeCLIContext): Promise<number> {
  const args = parseArguments(context.argv), [command, action, ...values] = args.positionals;
  const root = process.env.LAKE_HOME ?? join(homedir(), ".lake");
  const runtime = await createLakeRuntime({ root });
  const dispatch = (method: string, params: Params = {}) => runtime.dispatch({ method, params });
  let result: JsonValue = null;
  try {
    switch (command) {
      case "ls": result = await dispatch("lake.list"); break;
      case "current": result = await dispatch("lake.current"); break;
      case "add": result = await dispatch("lake.add", { name: action, description: flag(args, "desc") }); break;
      case "use": result = await dispatch("lake.use", { lake: action }); break;
      case "settings": result = await dispatch("settings", await readRequest(context)); break;
      case "res": result = await resourceCommand(context, runtime, args, root); break;
      case "model": result = await modelCommand(context, runtime, args, root); break;
      case "workflow": case "workflow-v2": result = await workflowCommand(context, runtime, args); break;
      case "rpc": {
        const request = await readRequest(context); result = await dispatch(text(request, "method"), object(request.params)); break;
      }
      case "permissions": result = await dispatch(action === "set" ? "permissions.set" : "permissions.get", { key: values[0] ?? "", enabled: values[1] === "on" || values[1] === "true" }); break;
      case "conversation": {
        const method = action === "archived" ? "list" : action;
        result = await dispatch(`conversation.${method}`, { id: values[0] ?? "", lake: values[0] ?? "", title: values.slice(1).join(" "), archived: action === "archived" }); break;
      }
      case "memory": {
        const lake = object(await dispatch("lake.current"));
        if (!lake.name) throw new Error("当前未选择湖");
        const p = { lake: String(lake.name), id: values[0] ?? "", text: values.slice(1).join(" "), enabled: action === "on" };
        if (action === "on" || action === "off") await dispatch("memory.set", p);
        else if (action === "delete" || action === "edit") await dispatch(`memory.${action}`, p);
        else if (action !== "show" && action !== "list") throw new Error("未知的记忆操作");
        result = await dispatch("memory.show", p); break;
      }
      case "code": {
        if (action === "remote") {
          const [operation, first, second] = values;
          if (operation === "list") result = await dispatch("code.remote.list");
          else if (operation === "add") result = await dispatch("code.remote.add", { lake: first, name: second, resource: flag(args, "resource"), root: flag(args, "root") });
          else if (operation === "authz") result = await dispatch("code.remote.authorize", { id: first, enabled: second === "on" });
          else if (operation === "bind") { await dispatch("code.remote.bind", { id: first, workspace_id: second === "none" ? "" : second }); result = await dispatch("conversation.get", { id: first }); }
          else throw new Error("未知的远程代码工作区操作");
        } else if (action === "list") result = await dispatch("code.list");
        else if (action === "add") result = await dispatch("code.add", { lake: values[0], name: values[1], path: flag(args, "path") });
        else if (action === "bind") { await dispatch("code.bind", { id: values[0], project_id: values[1] === "none" ? "" : values[1] }); result = await dispatch("conversation.get", { id: values[0] }); }
        else throw new Error("未知的代码项目操作"); break;
      }
      case "journal": result = await dispatch("journal.list", { target_path: flag(args, "target"), run_id: flag(args, "run"), action_id: flag(args, "action"), limit: Number(flag(args, "limit", "100")) }); break;
      case "bridge": await runBridge(context, runtime, flag(args, "conversation")); return 0;
      default: throw new Error(`未知的 Lake 命令 ${command ?? ""}`);
    }
    context.stdout.write(JSON.stringify(result) + "\n"); return 0;
  } catch (error) {
    context.stderr.write(redact(error instanceof Error ? error.message : String(error)) + "\n"); return 1;
  } finally { await runtime.close(); }
}
