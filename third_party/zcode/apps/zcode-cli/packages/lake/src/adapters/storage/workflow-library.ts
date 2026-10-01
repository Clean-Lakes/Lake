import type { JsonValue } from "../../domain/json.js";
import { name, text, type Params, type View } from "../../domain/validation.js";
import { LakeDatabase, newID } from "./database.js";
import { CatalogRepository } from "./catalog.js";

const LIBRARY = `SELECT * FROM (
SELECT o.kind,o.id,o.lake_id,l.name lake,o.parent_id,o.position,o.name,'' description,1 enabled
FROM workflow_organization o JOIN lake l ON l.id=o.lake_id WHERE o.kind='folder'
UNION ALL
SELECT 'v1',w.id,w.lake_id,l.name,COALESCE(o.parent_id,''),COALESCE(o.position,2147483647),w.name,w.description,w.enabled
FROM ops_workflow w JOIN lake l ON l.id=w.lake_id LEFT JOIN workflow_organization o ON o.kind='v1' AND o.id=w.id AND o.lake_id=w.lake_id
UNION ALL
SELECT 'v2',w.id,w.lake_id,l.name,COALESCE(o.parent_id,''),COALESCE(o.position,2147483647),w.name,w.description,w.enabled
FROM workflow_v2_definition w JOIN lake l ON l.id=w.lake_id LEFT JOIN workflow_organization o ON o.kind='v2' AND o.id=w.id AND o.lake_id=w.lake_id
)`;
const FIELDS = new Set(["action", "lake", "kind", "id", "name", "parent_id", "before_kind", "before_id"]);
export class WorkflowLibraryRepository {
  constructor(private readonly db: LakeDatabase, private readonly catalog: CatalogRepository) {}
  private entries(lake = ""): View[] {
    return this.db.all(LIBRARY + (lake ? " WHERE lake=?" : "") + " ORDER BY lake,parent_id,position,lower(name),kind,id", ...(lake ? [lake] : [])).map(row => ({ ...row, enabled: row.enabled === 1 }));
  }
  request(p: Params): JsonValue {
    if (JSON.stringify(p).length > 8192 || Object.keys(p).some(key => !FIELDS.has(key) || typeof p[key] !== "string")) throw new Error("目录请求无效");
    const action = text(p, "action"), lake = text(p, "lake"), parent = text(p, "parent_id"), id = text(p, "id");
    if (action === "list") return { entries: this.entries(lake) };
    if (!lake) throw new Error("目录操作需要指定所属湖");
    return this.db.transaction(() => {
      const lakeID = String(this.catalog.lake(lake).id), entries = this.entries(lake);
      const find = (kind: string, target: string): View => {
        const entry = entries.find(entry => entry.kind === kind && entry.id === target);
        if (!entry) throw new Error("目录对象不存在或属于其他湖"); return entry;
      };
      if (parent) find("folder", parent);
      const uniqueName = (value: string, target: string, except = ""): string => {
        const valid = name(value);
        if (entries.some(entry => entry.kind === "folder" && entry.parent_id === target && entry.id !== except && String(entry.name).toLowerCase() === valid.toLowerCase())) throw new Error("同级目录名称已存在"); return valid;
      };
      let created = "";
      if (action === "rename_folder") {
        const entry = find("folder", id), value = uniqueName(text(p, "name"), String(entry.parent_id), id);
        this.db.run("UPDATE workflow_organization SET name=? WHERE kind='folder' AND id=? AND lake_id=?", value, id, lakeID);
      } else if (action === "delete_folder") {
        find("folder", id);
        if (entries.some(entry => entry.parent_id === id)) throw new Error("目录非空，请先移出工作流和子目录");
        this.db.run("DELETE FROM workflow_organization WHERE kind='folder' AND id=? AND lake_id=?", id, lakeID);
      } else if (action === "create_folder" || action === "move") {
        let moving: View;
        if (action === "create_folder") { created = newID(); moving = { kind: "folder", id: created, lake_id: lakeID, lake, name: uniqueName(text(p, "name"), parent), enabled: true, parent_id: "", position: 0 }; }
        else {
          moving = find(text(p, "kind"), id);
          if (moving.kind === "folder") {
            uniqueName(String(moving.name), parent, id); const seen = new Set<string>();
            for (let ancestor = parent; ancestor;) {
              if (ancestor === id || seen.has(ancestor)) throw new Error("不能将目录移入自身或子目录");
              seen.add(ancestor); ancestor = String(find("folder", ancestor).parent_id);
            }
          }
        }
        const beforeID = text(p, "before_id"), beforeKind = text(p, "before_kind");
        if (!!beforeID !== !!beforeKind) throw new Error("排序目标无效");
        if (beforeID === moving.id && beforeKind === moving.kind) {
          if (moving.parent_id !== parent) throw new Error("排序目标不在目标目录");
        } else {
          const siblings = entries.filter(entry => entry.parent_id === parent && !(entry.id === moving.id && entry.kind === moving.kind));
          const at = beforeID ? siblings.findIndex(entry => entry.id === beforeID && entry.kind === beforeKind) : siblings.length;
          if (at < 0) throw new Error("排序目标已移动，请刷新后重试");
          siblings.splice(at, 0, moving);
          for (const [position, entry] of siblings.entries()) this.db.run("INSERT INTO workflow_organization(kind,id,lake_id,parent_id,position,name) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET parent_id=excluded.parent_id,position=excluded.position,name=excluded.name WHERE workflow_organization.lake_id=excluded.lake_id", String(entry.kind), String(entry.id), lakeID, parent, position, String(entry.name));
        }
      } else throw new Error("未知目录操作");
      return { entries: this.entries(), ...(created ? { created_id: created } : {}) };
    });
  }
}
