import type { LakeCLIContext } from "../../domain/cli.js";
import type { LakeRuntime } from "../../domain/protocol.js";
import type { JsonValue } from "../../domain/json.js";
import { object, type Params } from "../../domain/validation.js";
import { FileVault } from "../vault.js";
import { kubeContexts, kubeconfigView } from "../execution/kubeconfig.js";
import { flag, readInput, type Arguments } from "./arguments.js";
import { privateInput } from "./private-input.js";

function sshSpec(value: string): Params {
  const match = /^([^@\s]+)@(.+)$/u.exec(value);
  if (!match) throw new Error("SSH 地址需要 用户@主机[:端口]");
  const url = new URL("ssh://" + value);
  if (url.password || url.pathname || url.search || url.hash) throw new Error("SSH 地址无效");
  return { username: decodeURIComponent(url.username), host: url.hostname.replace(/^\[|\]$/gu, ""), port: url.port ? Number(url.port) : 22 };
}
export async function resourceCommand(context: LakeCLIContext, runtime: LakeRuntime, args: Arguments, root: string): Promise<JsonValue> {
  const [, action, selector = ""] = args.positionals, vault = new FileVault(root);
  const dispatch = (method: string, params: Params) => runtime.dispatch({ method, params });
  if (action === "ls") {
    const current = args.flags.has("all") ? {} : object(await dispatch("lake.current", {}));
    return dispatch("res.list", { lake: flag(args, "lake", selector || String(current.name ?? "")) });
  }
  if (action === "authz") {
    const decision = args.positionals[3];
    if (!["allow", "deny"].includes(decision)) throw new Error("授权值需要 allow 或 deny");
    return dispatch("res.authorize", { resource: selector, allow: decision === "allow" });
  }
  if (action === "k8s-contexts") return kubeContexts(flag(args, "kubeconfig"));
  if (action === "identity") {
    const key = await privateInput(flag(args, "file")); let reference = "";
    try {
      reference = await vault.import("ssh", key);
      return await dispatch("res.set_credential", { resource: selector, credential_ref: reference });
    } catch (error) { if (reference) await vault.deleteReference(reference); throw error; }
    finally { key.fill(0); }
  }
  if (!["add", "add-db", "add-k8s"].includes(action)) throw new Error("未知的资源操作");
  const split = selector.split("/");
  const current = split.length === 1 ? object(await dispatch("lake.current", {})) : {};
  const lake = split.length === 2 ? split[0] : String(current.name ?? ""), name = split.at(-1) ?? "";
  if (!lake || !name || split.length > 2) throw new Error("资源路径需要 湖/资源名");
  const tags: Params = {};
  for (const item of args.flags.get("tag") ?? []) {
    const index = item.indexOf("="); if (index < 1) throw new Error("标签需要 键=值"); tags[item.slice(0, index)] = item.slice(index + 1);
  }
  let kind = "host", spec: Params = {}, reference = "";
  try {
    if (action === "add") {
      spec = { ssh: sshSpec(flag(args, "ssh")) };
      if (args.flags.has("identity")) { const value = await privateInput(flag(args, "identity")); try { reference = await vault.import("ssh", value); } finally { value.fill(0); } }
    } else if (action === "add-db") {
      const requested = flag(args, "kind"); kind = requested === "pg" || requested === "postgresql" ? "postgres" : requested;
      spec = { db: { host: flag(args, "host"), port: Number(flag(args, "port", kind === "postgres" ? "5432" : kind === "starrocks" ? "9030" : "3306")), username: flag(args, "user"), database: flag(args, "database", kind === "postgres" ? "postgres" : ""), tls_mode: flag(args, "tls", "verify") } };
      if (args.flags.has("password-stdin")) { const value = await readInput(context, 65536); try { if (value.length) reference = await vault.import("database", value); } finally { value.fill(0); } }
    } else {
      kind = "k8s";
      const path = flag(args, "kubeconfig"), contexts = await kubeContexts(path), selected = flag(args, "context", String(contexts["current-context"]));
      if (!selected || !(contexts.contexts as Params[]).some(item => item.name === selected)) throw new Error("kubeconfig 中不存在所选 context");
      const value = await kubeconfigView(path, ["view", "--raw", "--flatten", "--minify", "--context", selected, "--output=json"]);
      try {
        const imported = object(JSON.parse(value.toString()));
        if (imported["current-context"] !== selected || (imported.contexts as JsonValue[]).length !== 1) throw new Error("无法独立导入所选 context");
        reference = await vault.import("kubeconfig", value);
      } finally { value.fill(0); }
      spec = { k8s: { context: selected, namespace: flag(args, "namespace", "default") } };
    }
    return await dispatch("res.add", { lake, name, kind, spec, env: flag(args, "env"), tags, ...(reference ? { credential_ref: reference } : {}) });
  } catch (error) { if (reference) await vault.deleteReference(reference); throw error; }
}
