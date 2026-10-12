import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { Store, ApiFailure } from "./store.js";
export function inputReferences(store: Store, session: string, value: unknown): Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 40) throw new ApiFailure(400, "最多 40 项上下文引用");
  return value.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiFailure(400, "Invalid reference");
    const r = value as Record<string, unknown>; const kind = String(r.kind); const field = (key: string, max = 1000) => typeof r[key] === "string" && String(r[key]).length <= max ? String(r[key]) : "";
    const ref = field("asset_ref") || field("assetRef");
    const resource = ref ? (store.assertSessionResource(session, ref), store.resource(ref)) : null;
    if (["file-local", "file-ssh", "file-container"].includes(kind)) {
      const path = field("path");
      if (!resource || !isAbsolute(path) || /[\r\n\0]/.test(path) || kind !== `file-${resource.kind === "docker" ? "container" : resource.kind}`) throw new ApiFailure(400, "File reference target/path invalid");
      const container = field("container_id") || field("containerId"); if (kind === "file-container" && !container) throw new ApiFailure(400, "Container reference needs container name");
      return { kind, label: path, path, runtime: resource.kind === "docker" ? "container" : resource.kind, asset_ref: resource.id, container_id: container, file_ref: "f_" + createHash("sha256").update(JSON.stringify([resource.id, container, path])).digest("hex").slice(0, 16) };
    }
    if (kind === "db-object") {
      if (resource?.kind !== "database") throw new ApiFailure(400, "Database reference requires a database asset");
      const db = field("db"), schema = field("schema"), table = field("table"); if (!schema || !table) throw new ApiFailure(400, "Schema/table required");
      return { kind, asset_ref: resource.id, db, schema, table, object_type: "table", label: `${resource.name} · ${schema}.${table}` };
    }
    if (kind === "terminal-tab" || kind === "terminal-command-block") {
      const terminalId = field("terminal_id") || field("terminalId"); const terminal = store.terminal(session, terminalId); const host = store.resource(terminal.resourceId);
      if (kind === "terminal-tab") return { kind, terminal_id: terminalId, asset_ref: host.id, label: `${host.name} 终端`, status: terminal.status };
      const block = field("block_id") || field("blockId"); const entry = store.commandEntry(session, terminalId, block);
      return { kind, terminal_id: terminalId, block_id: block, asset_ref: host.id, label: entry.command, command: entry.command, output: entry.output.slice(-10000), exitCode: entry.exitCode };
    }
    throw new ApiFailure(400, "Unsupported reference kind");
  });
}
