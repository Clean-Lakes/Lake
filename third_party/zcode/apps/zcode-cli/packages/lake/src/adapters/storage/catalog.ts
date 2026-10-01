import type { JsonValue } from "../../domain/json.js";
import { hasControl, integer, name, object, parseObject, text, type Params, type View } from "../../domain/validation.js";
import { LakeDatabase, newID, timeView } from "./database.js";

export class CatalogRepository {
  constructor(private readonly db: LakeDatabase) {}
  lake(selector: string): View {
    return this.db.one("SELECT * FROM lake WHERE id=? OR name=?", selector, selector);
  }
  resource(selector: string): View {
    let row: View;
    if (selector.includes("/")) {
      const [lake, resource] = selector.split("/");
      row = this.db.one("SELECT r.*,l.name lake FROM resource r JOIN lake l ON r.lake_id=l.id WHERE l.name=? AND r.name=?", lake, resource);
    } else row = this.db.one("SELECT r.*,l.name lake FROM resource r JOIN lake l ON r.lake_id=l.id WHERE r.id=?", selector);
    const spec = parseObject(String(row.spec));
    delete row.spec;
    return timeView({ ...row, ...spec, tags: JSON.parse(String(row.tags)) as JsonValue, execute_authz: row.execute_authz === 1 });
  }
  request(method: string, p: Params): JsonValue {
    switch (method) {
      case "lake.list": return this.db.all("SELECT * FROM lake ORDER BY name").map(timeView);
      case "lake.get": return timeView(this.lake(text(p, "lake")));
      case "lake.current": {
        const row = this.db.all("SELECT l.* FROM current_lake c JOIN lake l ON l.id=c.lake_id WHERE c.singleton=1")[0];
        return row ? timeView(row) : null;
      }
      case "lake.add": {
        const id = newID(), now = Date.now();
        this.db.run("INSERT INTO lake(id,name,description,created_at,updated_at) VALUES(?,?,?,?,?)", id, name(text(p, "name")), text(p, "description"), now, now);
        return timeView(this.lake(id));
      }
      case "lake.use": {
        const lake = this.lake(text(p, "lake"));
        this.db.run("UPDATE current_lake SET lake_id=? WHERE singleton=1", String(lake.id));
        return timeView(lake);
      }
      case "res.list": {
        let sql = "SELECT r.id FROM resource r JOIN lake l ON r.lake_id=l.id";
        const lake = text(p, "lake");
        if (lake) sql += " WHERE l.name=? OR l.id=?";
        return this.db.all(sql + " ORDER BY l.name,r.name", ...(lake ? [lake, lake] : [])).map(row => this.resource(String(row.id)));
      }
      case "res.get": return this.resource(text(p, "resource"));
      case "res.add": {
        const lake = this.lake(text(p, "lake")), id = newID(), now = Date.now();
        const kind = text(p, "kind", "host"), spec = object(p.spec);
        if (!["host", "k8s", "mysql", "postgres", "starrocks"].includes(kind)) throw new Error("未知的资源类型");
        const endpoint = object(spec[kind === "host" ? "ssh" : kind === "k8s" ? "k8s" : "db"]);
        if (kind === "k8s") { if (!text(endpoint, "context")) throw new Error("需要 Kubernetes 上下文"); }
        else {
          const host = text(endpoint, "host"), username = text(endpoint, "username");
          if (!host || !username || hasControl(host + username) || /\s/u.test(host + username)) throw new Error("无效的资源地址或用户名");
          const port = integer(endpoint, "port", kind === "host" ? 22 : kind === "postgres" ? 5432 : kind === "starrocks" ? 9030 : 3306);
          if (port < 1 || port > 65535) throw new Error("无效的端口");
          endpoint.port = port;
          if (kind !== "host" && !["disable", "verify"].includes(text(endpoint, "tls_mode", "verify"))) throw new Error("无效的 TLS 模式");
          spec[kind === "host" ? "ssh" : "db"] = endpoint;
        }
        this.db.transaction(() => {
          this.db.run("INSERT INTO resource(id,lake_id,kind,name,spec,execute_authz,env,tags,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?,?,?)", id, String(lake.id), kind, name(text(p, "name")), JSON.stringify(spec), text(p, "env"), JSON.stringify(object(p.tags)), now, now);
          if (p.credential_ref) this.setCredential(id, text(p, "credential_ref"));
        });
        return this.resource(id);
      }
      case "res.authorize": {
        const target = this.resource(text(p, "resource"));
        this.db.run("UPDATE resource SET execute_authz=?,updated_at=? WHERE id=?", p.allow === true ? 1 : 0, Date.now(), String(target.id));
        return this.resource(String(target.id));
      }
      case "res.identity": {
        const target = this.resource(text(p, "resource"));
        this.db.run("UPDATE resource SET env=?,tags=?,updated_at=? WHERE id=?", text(p, "env", String(target.env)), JSON.stringify(p.tags ?? target.tags), Date.now(), String(target.id));
        return this.resource(String(target.id));
      }
      case "res.set_credential": {
        const target = this.resource(text(p, "resource"));
        this.setCredential(String(target.id), text(p, "credential_ref")); return null;
      }
      case "res.credential": {
        const target = this.resource(text(p, "resource"));
        return this.db.one("SELECT ref FROM attach WHERE resource_id=? AND kind='credential'", String(target.id));
      }
      case "permissions.get": return this.policy();
      case "permissions.set": {
        const key = text(p, "key");
        if (key !== "ssh-read" && key !== "ssh-command") throw new Error("未知的权限");
        this.db.run(`UPDATE permission_policy SET ${key === "ssh-read" ? "silent_ssh_read" : "silent_ssh_command"}=? WHERE singleton=1`, p.enabled === true ? 1 : 0);
        return this.policy();
      }
      default: throw new Error(`未知的数据命令 ${method}`);
    }
  }
  private policy(): View {
    const row = this.db.one("SELECT * FROM permission_policy WHERE singleton=1");
    return { silent_ssh_read: row.silent_ssh_read === 1, silent_ssh_command: row.silent_ssh_command === 1 };
  }
  private setCredential(resource: string, ref: string): void {
    if (!/^(?:file:(?:ssh|kubeconfig|database)\/[a-z0-9_-]+|keychain:.+|encrypted-file:.+)$/u.test(ref) || hasControl(ref)) throw new Error("无效的凭据引用");
    this.db.run("INSERT INTO attach(id,resource_id,kind,ref,meta,created_at) VALUES(?,?,'credential',?,'{}',?) ON CONFLICT(resource_id) WHERE kind='credential' DO UPDATE SET ref=excluded.ref", newID(), resource, ref, Date.now());
  }
}
