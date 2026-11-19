import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { JumpServerBinding, JumpServerLogin, JumpServerMount, Resource, ResourceTreeNode } from "../../web-agent/shared/contracts";
import { JumpServerAPI, hostName, loginConfiguration, uuid, type AuthorizedAccount, type Directory } from "./jumpserver-api";
import { LakeStore, privateDirectory, HttpError, id, now } from "./store";
import type { LakeSecurity } from "./security";
import { digest } from "./tasks";

type Binding = JumpServerBinding & {credentialId: string};
type Live = {bindingId: string; revision: number; resourceId: string; account: AuthorizedAccount; close: () => void};
const stopped = () => new HttpError(409, "JumpServer 绑定或资源已变化，请重新连接");
function scopedId(binding: string, name: string) {
  const bytes = createHash("sha1").update(Buffer.from(binding.replaceAll("-",""),"hex")).update(name).digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.subarray(0,16).toString("hex");
  return [h.slice(0,8),h.slice(8,12),h.slice(12,16),h.slice(16,20),h.slice(20)].join("-");
}

/** The authenticated desktop Home owns each personal mount; projects never borrow another project's binding. */
export class LakeJumpServer {
  private readonly shutdown = new AbortController();
  private readonly running = new Map<string,Promise<JumpServerBinding>>();
  private readonly live = new Set<Live>();
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(readonly store: LakeStore, readonly security: LakeSecurity, readonly registerSecret: (s: string)=>void,
              readonly changed: (projectId: string)=>void = ()=>{}) {
    this.timer = setInterval(()=>this.refreshAll(), 30000);
    this.timer.unref();
  }
  private refreshAll() {
    for (const b of this.store.list<Binding>("jumpServerBindings"))
      if (!this.store.get("navigationTrash","project:" + b.projectId)) void this.sync(b.projectId).catch(()=>{});
  }
  private current(projectId: string) { return this.store.get<Binding>("jumpServerBindings",projectId); }
  private public(binding: Binding): JumpServerBinding {
    const {credentialId, ...view} = binding;
    return view;
  }
  view(projectId: string) { this.store.project(projectId); const b = this.current(projectId); return b ? this.public(b) : null; }
  private assertCurrent(b: Binding) {
    const current = this.current(b.projectId);
    if (this.shutdown.signal.aborted || !current || current.id !== b.id || current.revision !== b.revision ||
        this.store.get("navigationTrash","project:" + b.projectId)) throw stopped();
    this.security.check();
  }
  private async secretPath(key: string) {
    if (!uuid.test(key)) throw stopped();
    const dir = join(this.store.home,"secrets");
    await privateDirectory(dir);
    return join(dir,"jumpserver-" + key + ".json");
  }
  private async client(b: Binding) {
    const file = await open(await this.secretPath(b.credentialId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await file.stat();
      if (!st.isFile() || st.size > 90000 || st.mode & 0o077 || process.platform !== "win32" && st.uid !== process.getuid?.()) throw stopped();
      const config = loginConfiguration(JSON.parse(await file.readFile("utf8")));
      if (config.origin !== b.origin || config.orgId !== b.orgId) throw stopped();
      this.registerSecret(config.secret);
      return new JumpServerAPI(config);
    } finally { await file.close(); }
  }
  async preview(projectId: string, input: JumpServerLogin, signal: AbortSignal) {
    this.security.resourceConfiguration(projectId,undefined,"network.fetch");
    const login = loginConfiguration(input);
    this.registerSecret(login.secret);
    const api = new JumpServerAPI(login);
    const profile = await api.profile(signal);
    const nodes = await api.nodes(signal);
    const byKey = new Map(nodes.map(n=>[n.key,n.name]));
    return {...profile, nodes:nodes.map(n=>{
      const keys = n.key.split(":");
      return {id:n.id, name:keys.map((_,i)=>byKey.get(keys.slice(0,i+1).join(":"))).filter(Boolean).join(" / ")};
    })};
  }
  async save(projectId: string, input: JumpServerMount, signal: AbortSignal) {
    this.security.resourceConfiguration(projectId,undefined,"network.fetch");
    const before = this.current(projectId);
    if (input.expectedRevision !== (before?.revision ?? 0)) throw stopped();
    if (!hostName(input.kokoHost) || !Number.isInteger(input.kokoPort) || input.kokoPort < 1 || input.kokoPort > 65535 ||
        input.nodeId !== null && !uuid.test(input.nodeId)) throw new HttpError(400,"请核对 KoKo SSH 地址、端口及挂载目录");
    const login = loginConfiguration(input);
    this.registerSecret(login.secret);
    const api = new JumpServerAPI(login), profile = await api.profile(signal);
    if (profile.userId !== input.userId || before && (before.userId !== profile.userId || before.orgId !== login.orgId || before.origin !== login.origin))
      throw new HttpError(409,"绑定身份已变化。切换堡垒机用户前请先解除当前绑定");
    const directory = await api.directory(input.nodeId,signal);
    const mount = directory.nodes.find(n=>n.id===input.nodeId);
    if (input.nodeId && !mount) throw new HttpError(403,"所选挂载目录不在此用户的授权范围");
    const credentialId = id(), path = await this.secretPath(credentialId);
    const binding: Binding = {id:before?.id ?? id(), projectId, revision:(before?.revision ?? 0)+1, origin:login.origin,
      orgId:login.orgId, ...profile, nodeId:input.nodeId, nodeName:mount?.name ?? "我的资产", authMethod:login.authMethod,
      kokoHost:input.kokoHost, kokoPort:input.kokoPort, lastSync:now(), state:"ready", assetCount:directory.assets.length, credentialId};
    const file = await open(path,"wx",0o600);
    try {
      try { await file.writeFile(JSON.stringify(login)); await file.sync(); } finally { await file.close(); }
      if (signal.aborted || this.shutdown.signal.aborted || this.current(projectId)?.credentialId !== before?.credentialId) throw stopped();
      this.security.resourceConfiguration(projectId,undefined,"network.fetch");
      this.apply(binding,directory);
    } catch (error) { await unlink(path).catch(()=>{}); throw error; }
    if (before) { this.disconnect(before.id); await unlink(await this.secretPath(before.credentialId)).catch(()=>{}); }
    this.changed(projectId);
    return this.public(binding);
  }
  private apply(b: Binding, directory: Directory) {
    const previous = this.store.list<Resource>("resources").filter(r=>r.jumpServer?.bindingId===b.id);
    const old = new Map(previous.map(r=>[r.id,r]));
    const nodes: ResourceTreeNode[] = [], next = new Map<string,Resource>();
    const root = scopedId(b.id,"mount"), byKey = new Map(directory.nodes.map(n=>[n.key,n]));
    const localNode = (nodeId: string)=>scopedId(b.id,"node/" + nodeId);
    const folder = (id: string, parentId: string|null, name: string) => nodes.push({id,parentId,name,
      bindingId:b.id, projectId:b.projectId, kind:"folder", resourceId:null, position:nodes.length});
    folder(root,null,"JumpServer · " + b.username);
    for (const n of directory.nodes) {
      const parent = byKey.get(n.key.split(":").slice(0,-1).join(":"));
      folder(localNode(n.id),parent ? localNode(parent.id) : root,n.name);
    }
    for (const asset of directory.assets) {
      const resourceId = scopedId(b.id,"asset/" + asset.id), prev = old.get(resourceId);
      const jumpServer = {...prev?.jumpServer, bindingId:b.id, assetId:asset.id, endpointHash:digest(asset.endpoint)};
      const resource: Resource = {id:resourceId, projectId:b.projectId, kind:asset.ssh ? "ssh" : "jumpserver",
        name:asset.name, description:"JumpServer · " + b.username, status:asset.ssh ? "available" : "unavailable", jumpServer};
      next.set(resourceId,resource);
      for (const parent of asset.nodes.length ? asset.nodes.map(localNode) : [root])
        nodes.push({id:scopedId(b.id,"link/" + parent + "/" + asset.id), projectId:b.projectId, parentId:parent, bindingId:b.id,
          kind:"resource", name:asset.name, resourceId, position:nodes.length});
    }
    const priorNodes=this.store.list<ResourceTreeNode>("tree").filter(n=>n.bindingId===b.id);
    const entryIds=new Set(nodes.map(n=>n.id));
    const invalidated=new Set<string>();
    this.store.transaction(()=>{
      for (const r of previous) if (!next.has(r.id)) {
        this.store.delete("resources",r.id); this.bump(r.id); invalidated.add(r.id);
      }
      for (const r of next.values()) {
        const prev=old.get(r.id);
        if (!prev || digest([prev.kind,prev.jumpServer]) !== digest([r.kind,r.jumpServer])) { this.bump(r.id); invalidated.add(r.id); }
        this.store.put("resources",r.id,r);
      }
      for (const n of priorNodes) if (!entryIds.has(n.id)) this.store.delete("tree",n.id);
      for (const n of nodes) this.store.put("tree",n.id,n);
      this.store.put("jumpServerBindings",b.projectId,b);
    });
    for (const live of this.live) if (invalidated.has(live.resourceId)) live.close();
  }
  private bump(resourceId: string) {
    this.store.put("resourceRevisions",resourceId,(this.store.get<number>("resourceRevisions",resourceId) ?? 0)+1);
  }
  private disconnect(bindingId: string) { for (const entry of this.live) if (entry.bindingId===bindingId) entry.close(); }
  async remove(projectId: string, bindingId: string, revision: number) {
    this.security.resourceConfiguration(projectId);
    const b=this.current(projectId);
    if (!b || b.id!==bindingId || b.revision!==revision) throw stopped();
    this.apply(b,{nodes:[],assets:[]});
    this.store.transaction(()=>{
      this.store.delete("tree",scopedId(b.id,"mount"));
      this.store.delete("jumpServerBindings",projectId);
    });
    this.disconnect(b.id); this.changed(projectId);
    await unlink(await this.secretPath(b.credentialId)).catch(()=>{});
  }
  sync(projectId: string): Promise<JumpServerBinding> {
    const b=this.current(projectId);
    if (!b) return Promise.reject(stopped());
    const key=b.id + "/" + b.revision, pending=this.running.get(key);
    if (pending) return pending;
    const job=this.refresh(b).finally(()=>this.running.delete(key));
    this.running.set(key,job);
    return job;
  }
  private async refresh(b: Binding) {
    const signal=this.shutdown.signal;
    try {
      this.assertCurrent(b);
      this.security.resourceConfiguration(b.projectId,undefined,"network.fetch");
      const api=await this.client(b), user=await api.profile(signal);
      if (user.userId!==b.userId) throw new HttpError(403,"JumpServer 登录身份已变化");
      const directory=await api.directory(b.nodeId,signal);
      this.assertCurrent(b);
      const current={...b, ...user, nodeName:directory.nodes.find(n=>n.id===b.nodeId)?.name ?? b.nodeName,
        state:"ready" as const,lastSync:now(),assetCount:directory.assets.length};
      this.apply(current,directory);
      await this.checkActive(current,api);
      this.assertCurrent(b);
      this.changed(b.projectId);
      return this.public(current);
    } catch (error) {
      this.assertCurrent(b);
      const denied=error instanceof HttpError && [401,403].includes(error.status);
      const failed: Binding={...b,state:denied ? "denied" : "offline"};
      if (denied) { failed.assetCount=0; this.apply(failed,{nodes:[],assets:[]}); }
      else this.store.put("jumpServerBindings",b.projectId,failed);
      this.disconnect(b.id); this.changed(b.projectId);
      throw error;
    }
  }
  private async checkActive(b: Binding, api: JumpServerAPI) {
    const groups=new Map<string,Live[]>();
    for (const e of this.live) if (e.bindingId===b.id) groups.set(e.resourceId,[...(groups.get(e.resourceId) ?? []),e]);
    await Promise.all([...groups].map(async ([id,handles])=>{
      const ref=this.store.get<Resource>("resources",id)?.jumpServer;
      const allowed=ref ? await api.accounts(ref.assetId,this.shutdown.signal).catch(()=>[]) : [];
      for (const e of handles) if (e.revision!==b.revision || !allowed.some(a=>a.id===e.account.id && a.alias===e.account.alias)) e.close();
    }));
  }
  resource(resource: Resource) {
    const b=this.current(resource.projectId), r=this.store.get<Resource>("resources",resource.id);
    if (!b || !r?.jumpServer || !resource.jumpServer || b.id!==r.jumpServer.bindingId || b.id!==resource.jumpServer.bindingId || r.jumpServer.assetId!==resource.jumpServer.assetId) throw stopped();
    return b;
  }
  revision(resource: Resource) {
    const b=this.resource(resource);
    return digest([b.id,b.revision,resource.id,resource.jumpServer,this.store.get("resourceRevisions",resource.id)]);
  }
  private async authorization(resource: Resource, signal: AbortSignal) {
    const initial=this.revision(resource), b=this.resource(resource);
    await this.sync(b.projectId);
    const current=this.store.get<Resource>("resources",resource.id);
    if (!current?.jumpServer || current.status!=="available" || this.revision(current)!==initial || signal.aborted) throw stopped();
    const api=await this.client(b), accounts=await api.accounts(current.jumpServer.assetId,signal);
    this.assertCurrent(b);
    if (this.revision(this.store.require<Resource>("resources",resource.id))!==initial || signal.aborted) throw stopped();
    return {b,api,accounts,current,initial};
  }
  async accounts(resource: Resource, signal: AbortSignal) {
    this.security.resourceConfiguration(resource.projectId,resource.id,"network.fetch");
    return (await this.authorization(resource,signal)).accounts;
  }
  async choose(resource: Resource, accountId: string, signal: AbortSignal) {
    this.security.resourceConfiguration(resource.projectId,resource.id,"network.fetch");
    const {current,accounts}=await this.authorization(resource,signal);
    const choice=accounts.find(a=>a.id===accountId);
    if (!choice) throw stopped();
    this.security.resourceConfiguration(resource.projectId,resource.id,"network.fetch");
    this.store.transaction(()=>{
      this.store.put("resources",current.id,{...current,jumpServer:{...current.jumpServer!,accountId:choice.id,accountAlias:choice.alias}});
      this.bump(current.id);
    });
    for (const handle of this.live) if (handle.resourceId===current.id) handle.close();
    this.changed(current.projectId);
    return choice;
  }
  async connect(resource: Resource, signal: AbortSignal) {
    const {b,api,accounts,current,initial}=await this.authorization(resource,signal);
    const ref=current.jumpServer!;
    const account=ref.accountId ? accounts.find(a=>a.id===ref.accountId && a.alias===ref.accountAlias) : accounts.length===1 ? accounts[0] : undefined;
    if (!account) throw new HttpError(403,accounts.length ? "请在该资产的 JumpServer 账号设置中选择当前授权账号" : "没有获准连接的 SSH 账号");
    const ticket=await api.ticket(ref.assetId,account,signal);
    this.registerSecret(ticket.password);
    const check=()=>{
      this.assertCurrent(b);
      if (signal.aborted || this.revision(this.store.require<Resource>("resources",resource.id))!==initial) throw stopped();
    };
    check();
    return {host:b.kokoHost, port:b.kokoPort, username:"JMS-" + ticket.id, password:ticket.password, check,
      audit:{bindingId:b.id,userId:b.userId,orgId:b.orgId,assetId:ref.assetId,accountId:account.id,accountAlias:account.alias,connectionTokenId:ticket.id},
      track:(close:()=>void)=>{
        check();const handle={bindingId:b.id,revision:b.revision,resourceId:resource.id,account,close};
        this.live.add(handle); return ()=>this.live.delete(handle);
      }};
  }
  async close() {
    clearInterval(this.timer);this.shutdown.abort();
    for (const handle of this.live) handle.close();
    await Promise.allSettled(this.running.values());
  }
}
