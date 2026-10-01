import { readFile } from "node:fs/promises";
import type { LakeCLIContext } from "../../domain/cli.js";
import type { LakeRuntime } from "../../domain/protocol.js";
import type { JsonValue } from "../../domain/json.js";
import { object, text, type Params } from "../../domain/validation.js";
import { flag, readRequest, type Arguments } from "./arguments.js";

export async function workflowCommand(context: LakeCLIContext, runtime: LakeRuntime, args: Arguments): Promise<JsonValue> {
  const [command, action, id, value] = args.positionals, v2 = command === "workflow-v2";
  const dispatch = (method: string, params: Params = {}) => runtime.dispatch({ method, params });
  const prefix = v2 ? "workflow.v2." : "workflow.";
  if (action === "manage") {
    const request = await readRequest(context), operation = text(request, "action");
    if (!["list", "get", "save", "amend", "enable", "runs", "status", "events"].includes(operation)) throw new Error("未知的工作流管理动作");
    return dispatch(prefix + operation, request);
  }
  if (action === "library") return dispatch("workflow.library", await readRequest(context));
  if (action === "list" || action === "runs") return dispatch(prefix + action, { lake: flag(args, "lake", ""), limit: Number(flag(args, "limit", "50")) });
  if (action === "show" || action === "status") return dispatch(prefix + (action === "show" ? "get" : "status"), { id });
  if (action === "enable") return dispatch(prefix + "enable", { id, enabled: value === "on" });
  if (action === "save" || action === "amend") {
    const path = flag(args, "file"), spec = path ? object(JSON.parse(await readFile(path, "utf8"))) : await readRequest(context);
    return dispatch(prefix + action, { id: action === "amend" ? id : "", lake: action === "save" ? id : flag(args, "lake"), spec, expected_revision: Number(flag(args, "revision", "0")) });
  }
  throw new Error("未知的工作流命令");
}
