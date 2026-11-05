import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { HttpError, LakeStore } from "./store";
import { digest } from "./tasks";

// Read the established Home's gate without changing its identity, epoch or
// grants. Unsupported legacy authority stays closed until its adapter exists.
// This is a migration barrier, not a replacement for the full Lake evaluator.
export class LakeSecurity {
  private identity?: string;
  private fenced = false;
  constructor(readonly store: LakeStore) {}
  private ownedFile(path: string, maximum = 4 * 1024 * 1024) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > maximum ||
        process.platform !== "win32" && info.uid !== process.getuid?.() || !realpathSync(path).startsWith(realpathSync(this.store.home) + sep))
      throw new HttpError(409, "安全状态文件无效，需要核实后恢复执行");
  }
  check() {
    if (this.fenced) throw new HttpError(409, "安全状态已失效，请重新启动并核实原任务");
    try { this.inspect(); }
    catch (error) { this.fenced = true; throw error instanceof HttpError ? error : new HttpError(409, "安全状态需核实，当前仅允许查看历史"); }
  }
  private inspect() {
    const controlPath = join(this.store.home, "security/control.json"), path = join(this.store.data, "adk/sessions.sqlite");
    let control: any;
    if (existsSync(controlPath)) {
      this.ownedFile(controlPath);
      control = JSON.parse(readFileSync(controlPath, "utf8"));
      if (control.formatVersion !== 1 || !/^[a-fA-F0-9]{64}$/.test(control.storeID) || !/^[a-fA-F0-9]{64}$/.test(control.recoveryEpoch) ||
          control.gate !== "open" || control.runtimeRoot !== realpathSync(join(this.store.data, "adk")))
        throw new HttpError(409, "安全恢复尚未完成，当前仅允许查看历史");
      const identity = digest([control.storeID, control.recoveryEpoch, control.runtimeRoot]);
      if (this.identity && this.identity !== identity) throw new HttpError(409, "安全恢复身份已变化，请重新启动并核实原任务");
      this.identity = identity;
    }
    if (!existsSync(path)) { if (control?.storeReady) throw new HttpError(409, "安全数据库缺失，当前仅允许查看历史"); return; }
    this.ownedFile(path, Number.MAX_SAFE_INTEGER);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const has = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if (has("security_schema_meta")) {
        const row = db.prepare("SELECT * FROM security_schema_meta WHERE id=1").get();
        if (!control || !row || row.schema_version !== 1 || Number(row.minimum_reader_version) > 3 ||
            row.store_id !== control.storeID || row.recovery_epoch !== control.recoveryEpoch || row.migration_state !== "ready")
          throw new HttpError(409, "安全数据库身份或版本需核实，当前仅允许查看历史");
      } else if (control?.storeReady) throw new HttpError(409, "安全数据库缺少版本记录，当前仅允许查看历史");
      if (has("security_runtime_mode")) {
        const mode = db.prepare("SELECT mode FROM security_runtime_mode WHERE id=1").get()?.mode;
        if (mode && mode !== "legacy") throw new HttpError(409, "已启用的安全执行模式尚需迁移核验，当前仅允许查看历史");
      }
    } finally { db.close(); }
  }
  readOnly() { try { this.check(); return false; } catch { return true; } }
  resource(projectId: string) {
    this.check();
    if (this.store.get("legacyProjectPolicies", projectId))
      throw new HttpError(409, "此项目的安全策略已保留，资源操作须完成迁移核验后继续");
  }
}
