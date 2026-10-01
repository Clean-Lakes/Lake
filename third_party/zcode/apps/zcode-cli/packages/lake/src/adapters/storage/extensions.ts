import { isAbsolute, join, normalize } from "node:path";
import type { JsonValue } from "../../domain/json.js";
import { name, text, type Params, type View } from "../../domain/validation.js";
import { LakeDatabase, timeView } from "./database.js";

export class ExtensionsRepository {
  constructor(private readonly db: LakeDatabase) {}
  private view(row: View): View { return timeView({ ...row, manifest_json: JSON.parse(String(row.manifest_json)) as JsonValue, enabled: row.enabled === 1 }); }
  request(method: string, p: Params): JsonValue {
    const plugin = method.startsWith("plugin."), kind = plugin ? "plugin" : "hook", action = method.split(".")[1], path = plugin ? "" : text(p, "workspace_path"), target = plugin ? text(p, "name") : "workspace";
    if (action === "list") return this.db.all("SELECT * FROM extension_config WHERE kind=? ORDER BY name,workspace_path", kind).map(row => this.view(row));
    if (action === "get") {
      const rows = this.db.all("SELECT * FROM extension_config WHERE kind=? AND name=? AND workspace_path=?", kind, target, path);
      return rows.length ? this.view(rows[0]) : null;
    }
    if (action === "save") {
      const hash = text(p, "sha256"), manifest = JSON.stringify(p.manifest_json ?? {}), now = Date.now();
      if (!/^[a-f0-9]{64}$/u.test(hash) || manifest.length > 65536) throw new Error("扩展声明无效");
      if (plugin) {
        if (!text(p, "version") || !text(p, "source") || !text(p, "install_path")) throw new Error("插件配置无效");
        this.db.run("INSERT INTO extension_config(kind,name,version,source,sha256,install_path,manifest_json,enabled,created_at,updated_at) VALUES('plugin',?,?,?,?,?,?,0,?,?) ON CONFLICT(kind,name,workspace_path) DO UPDATE SET version=excluded.version,source=excluded.source,sha256=excluded.sha256,install_path=excluded.install_path,manifest_json=excluded.manifest_json,enabled=0,updated_at=excluded.updated_at", name(target), text(p, "version"), text(p, "source"), hash, text(p, "install_path"), manifest, now, now);
      } else {
        if (!isAbsolute(path) || normalize(path) !== path) throw new Error("Hook 工作区路径无效");
        this.db.run("INSERT INTO extension_config(kind,name,workspace_path,version,source,sha256,install_path,manifest_json,declaration_sha256,enabled,created_at,updated_at) VALUES('hook','workspace',?,'1',?,?,?,'{}',?,0,?,?) ON CONFLICT(kind,name,workspace_path) DO UPDATE SET source=excluded.source,sha256=excluded.sha256,install_path=excluded.install_path,declaration_sha256=excluded.declaration_sha256,enabled=CASE WHEN extension_config.sha256=excluded.sha256 THEN extension_config.enabled ELSE 0 END,updated_at=excluded.updated_at", path, join(path, ".lake", "hooks.json"), hash, path, hash, now, now);
      }
      return this.request(plugin ? "plugin.get" : "hook.get", p);
    }
    if (action === "enable") {
      if (!this.db.run(`UPDATE extension_config SET enabled=?,updated_at=? WHERE kind=? AND name=? AND workspace_path=?${plugin ? "" : " AND sha256=?"}`, p.enabled === true ? 1 : 0, Date.now(), kind, target, path, ...(plugin ? [] : [text(p, "sha256")]))) throw new Error("扩展不存在或 Hook 声明已变化");
      return this.request(plugin ? "plugin.get" : "hook.get", p);
    }
    throw new Error("未知的扩展数据命令");
  }
}
