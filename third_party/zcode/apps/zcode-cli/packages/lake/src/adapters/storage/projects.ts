import { realpath, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { JsonValue } from "../../domain/json.js";
import { name, object, remoteRoot, text, type Params, type View } from "../../domain/validation.js";
import { LakeDatabase, newID, timeView } from "./database.js";
import { CatalogRepository } from "./catalog.js";

const PROJECT = "SELECT p.*,l.name lake FROM code_project p JOIN lake l ON p.lake_id=l.id";
const WORKSPACE = "SELECT w.*,l.name lake,r.spec FROM code_workspace w JOIN lake l ON w.lake_id=l.id JOIN resource r ON w.resource_id=r.id";
export class ProjectsRepository {
  constructor(private readonly db: LakeDatabase, private readonly catalog: CatalogRepository) {}
  private workspace(row: View): View {
    const spec = JSON.parse(String(row.spec)) as Params, ssh = object(spec.ssh);
    delete row.spec;
    return timeView({ ...row, host: ssh.host, port: ssh.port, username: ssh.username, authorized: row.authorized === 1 });
  }
  async request(method: string, p: Params): Promise<JsonValue> {
    const id = text(p, "id");
    switch (method) {
      case "code.list": return this.db.all(PROJECT + " ORDER BY l.name,p.name").map(timeView);
      case "code.get": return timeView(this.db.one(PROJECT + " WHERE p.id=?", id));
      case "code.add": {
        const lake = this.catalog.lake(text(p, "lake")), path = await realpath(resolve(text(p, "path")));
        if (!(await stat(path)).isDirectory()) throw new Error("代码项目路径必须是目录");
        const project = newID(), now = Date.now();
        this.db.run("INSERT INTO code_project(id,lake_id,name,path,created_at,updated_at) VALUES(?,?,?,?,?,?)", project, String(lake.id), name(text(p, "name", basename(path))), path, now, now);
        return timeView(this.db.one(PROJECT + " WHERE p.id=?", project));
      }
      case "code.bind": {
        const project = text(p, "project_id");
        if (project) {
          if (!this.db.run("UPDATE conversation SET project_id=?,remote_workspace_id=NULL,updated_at=? WHERE id=? AND archived_at IS NULL AND lake_id=(SELECT lake_id FROM code_project WHERE id=?)", project, Date.now(), id, project)) throw new Error("项目与会话不属于同一湖");
        } else if (!this.db.run("UPDATE conversation SET project_id=NULL,updated_at=? WHERE id=? AND archived_at IS NULL", Date.now(), id)) throw new Error("会话不存在");
        return null;
      }
      case "code.remote.list": return this.db.all(WORKSPACE + " ORDER BY l.name,w.name").map(row => this.workspace(row));
      case "code.remote.get": return this.workspace(this.db.one(WORKSPACE + " WHERE w.id=?", id));
      case "code.remote.add": {
        const lake = this.catalog.lake(text(p, "lake")), resource = this.catalog.resource(text(p, "resource"));
        if (resource.lake_id !== lake.id || resource.kind !== "host") throw new Error("远程工作区必须绑定同一湖的 SSH 主机");
        const workspace = newID(), now = Date.now();
        this.db.run("INSERT INTO code_workspace(id,lake_id,resource_id,name,remote_root,authorized,created_at,updated_at) VALUES(?,?,?,?,?,0,?,?)", workspace, String(lake.id), String(resource.id), name(text(p, "name")), remoteRoot(text(p, "root")), now, now);
        return this.workspace(this.db.one(WORKSPACE + " WHERE w.id=?", workspace));
      }
      case "code.remote.authorize": {
        if (!this.db.run("UPDATE code_workspace SET authorized=?,updated_at=? WHERE id=?", p.enabled === true ? 1 : 0, Date.now(), id)) throw new Error("工作区不存在");
        return this.workspace(this.db.one(WORKSPACE + " WHERE w.id=?", id));
      }
      case "code.remote.bind": {
        const workspace = text(p, "workspace_id");
        if (workspace) {
          if (!this.db.run("UPDATE conversation SET remote_workspace_id=?,project_id=NULL,updated_at=? WHERE id=? AND archived_at IS NULL AND lake_id=(SELECT lake_id FROM code_workspace WHERE id=? AND authorized=1)", workspace, Date.now(), id, workspace)) throw new Error("远程工作区未授权或不属于此会话的湖");
        } else if (!this.db.run("UPDATE conversation SET remote_workspace_id=NULL,updated_at=? WHERE id=?", Date.now(), id)) throw new Error("会话不存在");
        return null;
      }
      default: throw new Error(`未知的项目命令 ${method}`);
    }
  }
}
