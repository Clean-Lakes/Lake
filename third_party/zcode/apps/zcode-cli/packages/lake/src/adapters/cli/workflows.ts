import { readFile } from "node:fs/promises";
import type { LakeCLIContext } from "../../domain/cli.js";
import type { LakeRuntime } from "../../domain/protocol.js";
import type { JsonValue } from "../../domain/json.js";
import { object, text, type Params } from "../../domain/validation.js";
import { flag, readRequest, type Arguments } from "./arguments.js";
import { validateWorkflow } from "../../domain/workflow.js";

export async function workflowCommand(context: LakeCLIContext, runtime: LakeRuntime, args: Arguments): Promise<JsonValue> {
  const [command, action, id, value] = args.positionals, v2 = command === "workflow-v2";
  const dispatch = (method: string, params: Params = {}) => runtime.dispatch({ method, params });
  const prefix = v2 ? "workflow.v2." : "workflow.";
  if (action === "manage") {
    const request = await readRequest(context), operation = text(request, "action");
    if (request.definition) request.spec = object(JSON.parse(text(request, "definition")));
    if (operation === "validate" || operation === "preview") { const nodes = validateWorkflow(object(request.spec), 2); return { valid: true, definition: request.spec, nodes }; }
    if (!["list", "get", "save", "amend", "enable", "runs", "status", "events"].includes(operation)) throw new Error("未知的工作流管理动作");
    return dispatch("workflow.v2." + operation, request);
  }
  if (action === "library") return dispatch("workflow.library", await readRequest(context));
  if (action === "list" || action === "runs") return dispatch(prefix + action, { lake: flag(args, "lake", ""), limit: Number(flag(args, "limit", "50")) });
  if (action === "show" || action === "status") return dispatch(prefix + (action === "show" ? "get" : "status"), { id });
  if (action === "enable") return dispatch(prefix + "enable", { id, enabled: value === "on" });
  if (action === "run" || action === "resume") {
    const definitions = action === "run" ? await dispatch(prefix + "list") as Params[] : [];
    const definition = definitions.find(item => item.id === id || item.name === id);
    return dispatch(prefix + "execute", { ...(action === "run" ? { definition_id: definition?.id ?? id } : { run_id: id }), resource: flag(args, "resource"), targets: args.flags.get("target") ?? [], retry_writes: args.flags.has("retry-writes"), unattended: args.flags.has("unattended") });
  }
  if (action === "save" || action === "amend") {
    const path = flag(args, "file"), spec = path ? object(JSON.parse(await readFile(path, "utf8"))) : await readRequest(context);
    return dispatch(prefix + action, { id: action === "amend" ? id : "", lake: action === "save" ? id : flag(args, "lake"), spec, expected_revision: Number(flag(args, "revision", "0")) });
  }
  throw new Error("未知的工作流命令");
}
