import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { HttpError, LakeStore } from "./store";
import { digest } from "./tasks";
import type {DatabaseScope} from './mysql';

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
  network(projectId:string,address:string):'allow'|'ask' {
    this.check();this.store.project(projectId);let url:URL;try{url=new URL(address);}catch{throw new HttpError(400,'网页地址无效');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new HttpError(403,'网页读取仅允许不携带认证凭据的 HTTP(S) 地址');
    const legacy=this.store.get<any>('legacyProjectPolicies',projectId);if(!legacy)return 'allow';
    const policy=legacy.data;
    if(!policy||policy.SchemaVersion!==1||!policy.Confirmed||policy.ProjectID!==projectId||!['legacy','restricted','compatible'].includes(policy.Mode)||!Number.isSafeInteger(policy.Revision)||policy.Revision<1||!Array.isArray(policy.Rules))throw new HttpError(403,'原项目网络策略需要核实');
    const path=join(this.store.home,'security/control.json');if(existsSync(path)){const control=JSON.parse(readFileSync(path,'utf8'));if(policy.StoreID!==control.storeID||policy.RecoveryEpoch!==control.recoveryEpoch)throw new HttpError(409,'原项目安全身份已失效');}
    const rules=policy.Rules.filter((rule:any)=>rule.Capability==='network.fetch'&&!rule.ResourceIDs?.length);
    if(!rules.length||rules.some((rule:any)=>rule.Effect==='deny'))throw new HttpError(403,'原项目策略未允许该网页读取');
    let decision:'allow'|'ask'='allow';for(const rule of rules){
      if(rule.Limits&&Object.values(rule.Limits).some(value=>Array.isArray(value)?value.length:!!value))throw new HttpError(403,'受限网络策略需要对应地址范围适配器');
      if(rule.Effect==='ask'){if(!['single','either'].includes(rule.Confirmation))throw new HttpError(409,'原网页策略需要专用任务授权');decision='ask';}else if(rule.Effect!=='allow')throw new HttpError(403,'原网页策略无效');
    }return decision;
  }
  command(projectId:string,resourceId:string,provenReadOnly=false):'allow'|'ask' {
    this.check();const resource=this.store.require<any>('resources',resourceId);
    if(resource.projectId!==projectId||!['local','ssh'].includes(resource.kind)||resource.status!=='available')throw new HttpError(403,'命令资源不属于当前项目或连接不可用');
    const legacy=this.store.get<any>('legacyProjectPolicies',projectId);if(!legacy)return 'allow';
    const policy=legacy.data;
    if(!policy||policy.SchemaVersion!==1||!policy.Confirmed||policy.ProjectID!==projectId||!['legacy','restricted','compatible'].includes(policy.Mode)||!Number.isSafeInteger(policy.Revision)||policy.Revision<1||!Array.isArray(policy.Rules)||!policy.ResourceIDs?.includes(resourceId))throw new HttpError(403,'原项目策略不允许此命令资源');
    const path=join(this.store.home,'security/control.json');if(existsSync(path)){const control=JSON.parse(readFileSync(path,'utf8'));if(policy.StoreID!==control.storeID||policy.RecoveryEpoch!==control.recoveryEpoch)throw new HttpError(409,'原项目安全身份已失效');}
    let decision:'allow'|'ask'='allow';
    for(const capability of ['resource.resolve',...(resource.kind==='local'?['local.execute']:[]),provenReadOnly?'command.diagnostics':'terminal.execute']){
      const rules=policy.Rules.filter((rule:any)=>rule.Capability===capability&&(!rule.ResourceIDs?.length||rule.ResourceIDs.includes(resourceId)));
      if(!rules.length||rules.some((rule:any)=>rule.Effect==='deny'))throw new HttpError(403,'原项目策略禁止命令能力 '+capability);
      const specific=rules.filter((rule:any)=>rule.ResourceIDs?.length),width=specific.length?Math.min(...specific.map((rule:any)=>rule.ResourceIDs.length)):0;
      for(const rule of width?specific.filter((rule:any)=>rule.ResourceIDs.length===width):rules){
        if(rule.Limits&&Object.values(rule.Limits).some(value=>Array.isArray(value)?value.length:!!value))throw new HttpError(403,'通用 Shell 不能替代原策略的受限执行模板');
        if(rule.Effect==='ask'){if(!['single','either'].includes(rule.Confirmation))throw new HttpError(409,'原命令策略需要专用任务授权');decision='ask';}else if(rule.Effect!=='allow')throw new HttpError(403,'原命令策略无效');
      }
    }
    return decision;
  }
  database(projectId:string,resourceId:string,scope:DatabaseScope){
    this.check();const resource=this.store.require<any>('resources',resourceId);
    if(resource.projectId!==projectId||resource.kind!=='database'||resource.status!=='available'||resource.settings?.driver!=='mysql')throw new HttpError(403,'MySQL 资源不在当前项目或配置不可用');
    let decision:'allow'|'ask'='allow',maxRows=scope.maxRows,maxDurationMS=scope.maxDurationMS;
    const legacy=this.store.get<any>('legacyProjectPolicies',projectId);if(!legacy)return {decision,maxRows,maxDurationMS};
    const policy=legacy.data;
    if(!policy||policy.SchemaVersion!==1||!policy.Confirmed||policy.ProjectID!==projectId||!['legacy','restricted','compatible'].includes(policy.Mode)||!Number.isSafeInteger(policy.Revision)||policy.Revision<1||!Array.isArray(policy.Rules)||!Array.isArray(policy.ResourceIDs)||!policy.ResourceIDs.includes(resourceId))throw new HttpError(403,'原项目策略不允许此数据库范围');
    const path=join(this.store.home,'security/control.json');if(existsSync(path)){const control=JSON.parse(readFileSync(path,'utf8'));if(policy.StoreID!==control.storeID||policy.RecoveryEpoch!==control.recoveryEpoch)throw new HttpError(409,'原项目安全身份已失效');}
    for(const capability of ['resource.resolve','db.read']){
      const applicable=policy.Rules.filter((r:any)=>r.Capability===capability&&(!r.ResourceIDs?.length||r.ResourceIDs.includes(resourceId)));
      if(!applicable.length||applicable.some((r:any)=>r.Effect==='deny'))throw new HttpError(403,'原项目策略禁止数据库读取');
      const specific=applicable.filter((r:any)=>r.ResourceIDs?.length),width=specific.length?Math.min(...specific.map((r:any)=>r.ResourceIDs.length)):0;
      for(const rule of width?specific.filter((r:any)=>r.ResourceIDs.length===width):applicable){
        const limits=rule.Limits;
        if(limits&&Object.values(limits).some(v=>Array.isArray(v)?v.length>0:!!v)){
          if(capability!=='db.read'||Object.entries(limits).some(([k,v])=>!['DatabaseID','Schemas','MaxRows','MaxDurationMS'].includes(k)&&(Array.isArray(v)?v.length>0:!!v))||
            limits.DatabaseID!==scope.database||!Array.isArray(limits.Schemas)||!limits.Schemas.includes(scope.schema)||!Number.isSafeInteger(limits.MaxRows)||limits.MaxRows<1||!Number.isSafeInteger(limits.MaxDurationMS)||limits.MaxDurationMS<1)throw new HttpError(403,'数据库读取超出原策略的库/schema 范围');
          maxRows=Math.min(maxRows,limits.MaxRows);maxDurationMS=Math.min(maxDurationMS,limits.MaxDurationMS);
        }
        if(rule.Effect==='ask'){if(!['single','either'].includes(rule.Confirmation))throw new HttpError(409,'原数据库策略需要专用任务授权');decision='ask';}
        else if(rule.Effect!=='allow')throw new HttpError(403,'数据库读取规则无效');
      }
    }
    return {decision,maxRows,maxDurationMS};
  }
  host(projectId:string,resourceId:string):'allow'|'ask' {
    this.check();const resource=this.store.require<any>('resources',resourceId);
    if(resource.projectId!==projectId||resource.kind!=='ssh'||resource.status!=='available')throw new HttpError(403,'主机不在当前项目或连接配置不可用');
    const legacy=this.store.get<any>('legacyProjectPolicies',projectId);if(!legacy)return 'allow';
    const policy=legacy.data;
    if(!policy||policy.SchemaVersion!==1||!policy.Confirmed||policy.ProjectID!==projectId||!['legacy','restricted','compatible'].includes(policy.Mode)||!Number.isSafeInteger(policy.Revision)||policy.Revision<1||!Array.isArray(policy.Rules)||!Array.isArray(policy.ResourceIDs)||!policy.ResourceIDs.includes(resourceId))throw new HttpError(403,'原项目策略不允许此主机范围，或策略需核实');
    const path=join(this.store.home,'security/control.json');if(existsSync(path)){const control=JSON.parse(readFileSync(path,'utf8'));if(policy.StoreID!==control.storeID||policy.RecoveryEpoch!==control.recoveryEpoch)throw new HttpError(409,'原项目安全身份已失效');}
    let result:'allow'|'ask'='allow';
    for(const capability of ['command.diagnostics','resource.resolve']){
      const applicable=policy.Rules.filter((rule:any)=>rule.Capability===capability&&(!rule.ResourceIDs?.length||rule.ResourceIDs.includes(resourceId)));
      if(!applicable.length||applicable.some((rule:any)=>rule.Effect==='deny'))throw new HttpError(403,'原项目策略禁止此主机读取能力');
      const specific=applicable.filter((rule:any)=>rule.ResourceIDs?.length),width=specific.length?Math.min(...specific.map((rule:any)=>rule.ResourceIDs.length)):0;
      const rules=width?specific.filter((rule:any)=>rule.ResourceIDs.length===width):applicable;
      for(const rule of rules){
        if(rule.Limits&&Object.values(rule.Limits).some(value=>Array.isArray(value)?value.length>0:!!value))throw new HttpError(403,'此主机读取适配尚不能证明原策略的受限范围');
        if(rule.Effect==='ask'){if(!['single','either'].includes(rule.Confirmation))throw new HttpError(409,'原策略需要专用任务授权，不能以单次确认替代');result='ask';}
        else if(rule.Effect!=='allow')throw new HttpError(403,'原主机读取规则无效');
      }
    }
    return result;
  }
  mcp(projectId: string, capability: "mcp.discover" | "mcp.call" | "artifact.read", local: boolean): "allow" | "ask" {
    this.check();
    // Catalog v1 imported only visible projects. Until exact legacy service
    // descriptors are validated, an unresolved MCP call anywhere in the old
    // ledger remains an unknown service identity, including archived projects.
    const path = join(this.store.data, "adk/sessions.sqlite");
    if (capability === "mcp.call" && existsSync(path)) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_operations'").get() &&
            db.prepare("SELECT 1 FROM native_operations WHERE tool='call_mcp_tool' AND (status IN ('dispatched','running','unknown') OR (orphan_state <> '' AND risk_resolved_at IS NULL)) AND (closure_state IS NULL OR closure_state <> 'reconciled') LIMIT 1").get())
          throw new HttpError(409, "旧 MCP 调用的准确服务身份及结果仍需核实，不能跨项目重试");
      } finally { db.close(); }
    }
    const legacy = this.store.get<any>("legacyProjectPolicies", projectId);
    if (!legacy) return "allow";
    const policy = legacy.data;
    if (!policy || policy.SchemaVersion !== 1 || !policy.Confirmed || policy.ProjectID !== projectId || !Array.isArray(policy.Rules) ||
        !["legacy", "restricted", "compatible"].includes(policy.Mode) || !Number.isSafeInteger(policy.Revision) || policy.Revision < 1) throw new HttpError(409, "原项目策略需核实");
    const controlPath = join(this.store.home, "security/control.json");
    if (existsSync(controlPath)) {
      const control = JSON.parse(readFileSync(controlPath, "utf8"));
      if (policy.StoreID !== control.storeID || policy.RecoveryEpoch !== control.recoveryEpoch) throw new HttpError(409, "原项目策略的安全身份已失效");
    }
    if (local && policy.DenyLocal) throw new HttpError(403, "项目策略禁止本机 MCP 执行");
    let result: "allow" | "ask" = "allow";
    for (const name of [capability, ...(local ? ["local.execute"] : [])]) {
      const rules = policy.Rules.filter((rule: any) => rule.Capability === name && (!rule.ResourceIDs || !rule.ResourceIDs.length));
      if (!rules.length || rules.some((rule: any) => rule.Effect === "deny")) throw new HttpError(403, "项目策略禁止此 MCP 能力");
      for (const rule of rules) {
        if (rule.Limits && Object.values(rule.Limits).some((value) => Array.isArray(value) ? value.length > 0 : !!value)) throw new HttpError(403, "此 MCP 调用无法证明原策略的受限范围");
        if (rule.Effect === "ask") {
          if (!["single", "either"].includes(rule.Confirmation)) throw new HttpError(409, "原策略需要专用任务授权，不能以单次批准替代");
          result = "ask";
        } else if (rule.Effect !== "allow") throw new HttpError(403, "项目 MCP 策略无效");
      }
    }
    return result;
  }
}
