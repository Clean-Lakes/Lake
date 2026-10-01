import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue } from "../../domain/json.js";
import { name, redact, text, type Params } from "../../domain/validation.js";
import { LakeDatabase, newID, privateDirectory, timeView } from "./database.js";
import { CatalogRepository } from "./catalog.js";

const digest = (content: Uint8Array) => createHash("sha256").update(content).digest("hex");
export class ScriptsRepository {
  constructor(private readonly db: LakeDatabase, private readonly catalog: CatalogRepository) {}
  async request(method: string, p: Params): Promise<JsonValue> {
    const id = text(p, "id");
    if (method === "script.get") return timeView(this.db.one("SELECT * FROM script WHERE id=?", id));
    if (method === "script.list") {
      const lake = text(p, "lake"), resource = text(p, "resource");
      if (!lake === !resource) throw new Error("脚本须选择一个湖或资源");
      const scope = resource ? String(this.catalog.resource(resource).id) : String(this.catalog.lake(lake).id);
      return this.db.all(`SELECT * FROM script WHERE ${resource ? "resource_id" : "lake_id"}=? ORDER BY name`, scope).map(timeView);
    }
    if (method === "script.save") {
      const script = newID(), now = Date.now(), language = text(p, "language"), title = name(text(p, "name")), description = redact(text(p, "description")), content = Buffer.from(text(p, "content"));
      const lake = text(p, "lake"), resource = text(p, "resource");
      if (!lake === !resource || !language || language.length > 64 || !content.length || content.length > 1_048_576) throw new Error("脚本作用域、语言或大小无效");
      const lakeID = lake ? String(this.catalog.lake(lake).id) : null, resourceID = resource ? String(this.catalog.resource(resource).id) : null;
      const directory = join(this.db.root, "scripts"), relative = `scripts/${script}`, path = join(directory, script);
      await privateDirectory(directory); const file = await open(path, "wx", 0o600);
      let installed = false;
      try {
        await file.writeFile(content); await file.sync(); await file.close();
        this.db.transaction(() => {
          this.db.run("INSERT INTO script(id,name,language,path,sha256,description,lake_id,resource_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)", script, title, language, relative, digest(content), description, lakeID, resourceID, now, now);
          if (resourceID) this.db.run("INSERT INTO attach(id,resource_id,kind,ref,meta,created_at) VALUES(?,?,'script',?,'{}',?)", newID(), resourceID, script, now);
          this.db.run("INSERT INTO journal(ts,action_id,actor,target_path,tool,risk,event,detail) VALUES(?,?,'cli',?,'script.save','write','completed','')", now, newID(), resource || lake);
        }); installed = true;
        return this.request("script.get", { id: script });
      } finally { await file.close().catch(() => {}); content.fill(0); if (!installed) await rm(path, { force: true }); }
    }
    if (method === "script.read") {
      const script = this.db.one("SELECT * FROM script WHERE id=?", id);
      if (!/^[a-f0-9]{32}$/u.test(id) || script.path !== `scripts/${id}`) throw new Error("脚本索引路径无效");
      const file = await open(join(this.db.root, "scripts", id), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size > 1_048_576 || (info.mode & 0o077)) throw new Error("脚本文件权限或大小无效");
        const content = await file.readFile();
        if (content.length > 1_048_576 || digest(content) !== script.sha256) throw new Error("脚本内容与登记的 SHA-256 不同");
        return { script: timeView(script), content: new TextDecoder("utf8", { fatal: true }).decode(content) };
      } finally { await file.close(); }
    }
    throw new Error("未知的脚本数据命令");
  }
}
