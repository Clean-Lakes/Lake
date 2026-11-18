import {constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import type {Resource, ResourceImportPreview, ResourceImportRow} from '../../web-agent/shared/contracts';
import {HttpError, id, LakeStore} from './store';
import {digest} from './tasks';
import {hexHubIdentity, hexHubImportSource, type HexHubImportOptions, type ImportRecord} from './hexhub-import';
import {normalizeImportRecord, parseImportText} from './resource-import-text';
import {LakeResourceManagement, type PreparedResourceImport} from './resource-management';

type Candidate = {row:ResourceImportRow;resource?:Resource;target?:string;previous?:string;files:Record<string,string>;owned:string[];sourceIdentity?:string;sourceDigest?:string};
type Plan = {id:string;projectId:string;name:string;notice?:string;policy:string;expires:number;hexhub:boolean;candidates:Candidate[]};
type Receipt = {projectId:string;selection:string;count:number};
const lifetime = 30 * 60 * 1000;
const planName = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const serviceFields = ['driver','host','port','username','database','db','tls','sslmode','endpoint','authMethod','context','namespace','requestTimeout','tlsMode','password','token','apiKey','kubeconfig'];
const sshFields = ['host','port','username','authMethod','shell','password','passphrase','privateKey'];
const keys = (record:ImportRecord, names:string[]) => Object.fromEntries(names.filter(key => record[key] !== undefined).map(key => [key,record[key]]));
const configOf = (resource:Resource):ImportRecord => resource.kind === 'ssh' ? resource.ssh ?? {} : resource.settings ?? {};
const refsOf = (resource:Resource) => [configOf(resource).identityFile,configOf(resource).credentialRef].filter((value):value is string => typeof value === 'string' && !!value);
const host = (value:unknown) => typeof value === 'string' ? value.trim().toLowerCase().replace(/^\[|\]$/g,'').replace(/\.$/,'') : '';
function identity(kind:string, config:ImportRecord, withUser=true) {
  if (['ssh','database','redis'].includes(kind)) {
    const address = host(config.host);if (!address) return '';
    const port = config.port ?? (kind === 'ssh' ? 22 : kind === 'redis' ? 6379 : config.driver === 'postgres' ? 5432 : 3306);
    return JSON.stringify([kind,config.driver ?? '',address,port,kind === 'redis' ? config.db ?? 0 : config.database ?? '',withUser ? config.username ?? '' : '']);
  }
  if (typeof config.endpoint !== 'string' || !config.endpoint) return '';
  try {const url = new URL(config.endpoint);if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '';return JSON.stringify([kind,url.href.replace(/\/$/,''),config.context ?? '',config.namespace ?? '',withUser ? config.username ?? '' : '']);} catch {return '';}
}

/** Authenticated Items import. No connection probes, Worker grants or model loop. */
export class LakeResourceImport {
  private pending = new Set<AbortController>();
  private closed = false;
  constructor(readonly store:LakeStore, readonly management:LakeResourceManagement, readonly registerSecret:(value:string)=>void, readonly options:HexHubImportOptions={}) {}
  private directory() {
    const root = join(this.store.home,'secrets'), directory = join(root,'resource-imports');
    for (const path of [root,directory]) {
      mkdirSync(path,{recursive:true,mode:0o700});const info=lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077 || process.platform !== 'win32' && info.uid !== process.getuid?.()) throw new HttpError(409,'导入计划须保存在当前 Lake Home 的私有目录');
    }
    return directory;
  }
  private filePin(ref:string) {
    const root=join(this.store.home,'secrets'), path=isAbsolute(ref)?ref:resolve(root,ref);
    let fd:number|undefined;
    try {
      const dir=lstatSync(root), info=lstatSync(path);
      if (!path.startsWith(root+sep) || !realpathSync(path).startsWith(realpathSync(root)+sep) || dir.isSymbolicLink() || dir.mode & 0o077 || !info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size>6*1024*1024 || process.platform!=='win32' && (info.uid!==process.getuid?.()||dir.uid!==process.getuid?.())) throw new Error();
      fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const opened=fstatSync(fd), bytes=readFileSync(fd), after=fstatSync(fd);
      if ([opened,after].some(value=>value.dev!==info.dev||value.ino!==info.ino||value.size!==info.size||value.mtimeMs!==info.mtimeMs||value.ctimeMs!==info.ctimeMs)) throw new Error();
      return digest([ref,info.dev,info.ino,info.size,info.mtimeMs,info.ctimeMs,createHash('sha256').update(bytes).digest('hex')]);
    } catch {throw new HttpError(409,'导入凭据已变化或不属于当前 Lake Home，请重新预览');}
    finally {if(fd!==undefined)closeSync(fd);}
  }
  private readPlan(planId:unknown):Plan {
    if (typeof planId!=='string'||!planName.test(planId)) throw new HttpError(400,'导入计划身份无效');
    const path=join(this.directory(),planId+'.json');let fd:number|undefined;
    try {
      const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.mode&0o077||info.size>4*1024*1024||process.platform!=='win32'&&info.uid!==process.getuid?.())throw new Error();
      fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const opened=fstatSync(fd);if(opened.ino!==info.ino||opened.dev!==info.dev)throw new Error();
      const plan=JSON.parse(readFileSync(fd,'utf8')) as Plan;
      if(plan.id!==planId||!Array.isArray(plan.candidates)||plan.candidates.length>1000||!Number.isFinite(plan.expires))throw new Error();
      return plan;
    }catch{throw new HttpError(404,'导入计划不可用，请重新识别资源');}finally{if(fd!==undefined)closeSync(fd);}
  }
  private cleanup(plan:Plan) {
    const used=new Set(this.store.list<Resource>('resources').flatMap(refsOf));
    for(const ref of new Set(plan.candidates.flatMap(candidate=>candidate.owned))) {
      if(!/^(?:service-[a-f0-9-]+\.json|ssh-(?:key|secret)-[a-f0-9-]+)$/.test(ref)||used.has(ref)||used.has(join(this.store.home,'secrets',ref)))continue;
      try{this.filePin(ref);unlinkSync(join(this.store.home,'secrets',ref));}catch{/* Never follow changed paths during cleanup. */}
    }
  }
  private prune() {
    let active=0;
    for(const name of readdirSync(this.directory()))if(name.endsWith('.json')&&planName.test(name.slice(0,-5))) {
      try{const plan=this.readPlan(name.slice(0,-5));if(plan.expires<Date.now()){this.cleanup(plan);unlinkSync(join(this.directory(),name));this.store.delete('resourceImportReceipts',plan.id);}else active++;}catch{active++;}
    }
    if(active>=40)throw new HttpError(429,'待确认的导入计划过多，请稍后重试');
  }
  private complete(resource:Resource) {
    // An existing credential which cannot be read is an error, not permission
    // to replace it. Available passwordless DB/Redis resources are complete.
    refsOf(resource).forEach(ref=>this.filePin(ref));
    try {
      if(resource.kind==='ssh') {this.management.ssh.configuration(resource.ssh);return true;}
      this.management.services.validatePrepared(resource.kind,resource.settings??{});
      return resource.status==='available'||!!resource.settings?.credentialRef||resource.settings?.authMethod==='none';
    }catch{return false;}
  }
  private match(projectId:string,kind:string,config:ImportRecord) {
    const endpoint=identity(kind,config,false);if(!endpoint)return;
    const all=this.store.catalog().resources.filter(resource=>resource.projectId===projectId&&resource.kind===kind&&identity(kind,configOf(resource),false)===endpoint);
    const exact=all.filter(resource=>identity(kind,configOf(resource))===identity(kind,config));
    const complete=exact.find(resource=>this.complete(resource));if(complete)return complete;
    const missing=exact.length?exact:all.filter(resource=>!configOf(resource).username||!config.username);
    if(missing.length>1)throw new HttpError(409,'此端点匹配到多个缺少登录信息的资源，请先整理已有连接');
    return missing[0];
  }
  private candidate(projectId:string, raw:ImportRecord, index:number, hexhub:boolean):Candidate {
    const candidate:Candidate={row:{index,name:'',kind:'',folder:'',error:'',hasCredential:false},files:{},owned:[]};let rollback=()=>{};
    try {
      if(raw&&typeof raw==='object')for(const key of ['password','passphrase','privateKey','token','apiKey','kubeconfig']) {
        const value=raw[key]??raw.ssh?.[key]??raw.settings?.[key];if(typeof value==='string'&&value)this.registerSecret(value);
      }
      const record=normalizeImportRecord(raw),kind=record.kind;
      candidate.row={...candidate.row,name:record.name,kind,folder:record.folder};
      if(raw.importError)throw new HttpError(400,'此连接的格式、登录引用、代理或 TLS 配置不受支持，请在来源中检查此连接');
      if(record.folder.split('/').filter(Boolean).length>31)throw new HttpError(400,'资源目录最多支持 31 层');
      if(hexhub){candidate.sourceIdentity=hexHubIdentity(raw);candidate.sourceDigest=digest(raw);}
      let config=keys(record,kind==='ssh'?sshFields:serviceFields);
      if(kind==='ssh')Object.assign(config,{username:config.username??'root',authMethod:config.authMethod??(config.privateKey?'key':'password')});
      // Metadata-only sources can still identify a complete saved connection.
      let existing=this.match(projectId,kind,config);
      if(existing&&this.complete(existing)) {
        candidate.resource=existing;candidate.target=existing.id;candidate.previous=digest(existing);
      }else{
        if(existing&&!config.username&&configOf(existing).username)config.username=configOf(existing).username;
        if(kind==='ssh') {
          this.management.ssh.configuration(keys(config,['host','port','username','authMethod','shell']),true);
          const prepared=this.management.ssh.prepareImport(config,undefined,true);config=prepared.configuration;rollback=prepared.rollback;
        }else{
          const prepared=this.management.services.prepare(kind,config);config=prepared.settings;rollback=prepared.rollback;
        }
        const resource:Resource={id:id(),projectId,name:record.name,kind,description:'',settings:kind==='ssh'?{}:config,
          ...(kind==='ssh'?{ssh:config as Resource['ssh']}:{}),status:kind==='ssh'&&!(config.authMethod==='password'?config.credentialRef:config.identityFile)?'unavailable':'available',configurationRevision:1};
        candidate.owned=refsOf(resource);
        existing=this.match(projectId,kind,config);
        if(existing) {
          candidate.target=existing.id;candidate.previous=digest(existing);
          if(this.complete(existing)){rollback();candidate.owned=[];candidate.resource=existing;}
          else{
            const old=configOf(existing), filled={...old};
            if(!filled.username&&config.username)filled.username=config.username;
            if(kind==='ssh') {
              if(!old.identityFile&&!old.credentialRef){filled.authMethod=config.authMethod;if(config.identityFile)filled.identityFile=config.identityFile;if(config.credentialRef)filled.credentialRef=config.credentialRef;}
              this.management.ssh.configuration(filled,true);
            }else {
              if(!old.credentialRef&&config.credentialRef)filled.credentialRef=config.credentialRef;
              // Preserve endpoint, database, TLS, namespace and other old settings.
              this.management.services.validatePrepared(kind,filled);
            }
            candidate.resource={...existing,...(kind==='ssh'?{ssh:filled as Resource['ssh']}:{settings:filled}),status:resource.status};
          }
        }else candidate.resource=resource;
      }
      const resource=candidate.resource!, saved=configOf(resource);
      for(const ref of new Set([...refsOf(resource),...candidate.owned]))candidate.files[ref]=this.filePin(ref);
      Object.assign(candidate.row,keys(saved,['host','port','username','driver','database','endpoint','authMethod']),{hasCredential:!!(saved.credentialRef||saved.identityFile)});
    }catch(error){rollback();candidate.owned=[];delete candidate.resource;candidate.row.error=error instanceof HttpError?error.message:'连接配置无效，请检查字段和凭据格式';}
    return candidate;
  }
  async preview(projectId:string,input:ImportRecord,signal:AbortSignal):Promise<ResourceImportPreview> {
    if(this.closed)throw new HttpError(503,'资源导入正在停止');
    const policy=this.management.security.resourceConfiguration(projectId);this.prune();
    const controller=new AbortController();this.pending.add(controller);
    const abort=AbortSignal.any([signal,controller.signal]);let plan:Plan|undefined;
    try{
      if(Object.keys(input).some(key=>!['hexhub','name','text'].includes(key))||input.hexhub!==undefined&&typeof input.hexhub!=='boolean')throw new HttpError(400,'请提供连接文本或选择从 HexHub 导入');
      const hexhub=input.hexhub===true,source=hexhub?await hexHubImportSource(abort,this.options):{records:parseImportText(input.text),notice:undefined};
      const name=hexhub?'HexHub 资产':input.name??'文本资源配置';
      if(typeof name!=='string'||!name.trim()||[...name].length>160||/[\0\r\n]/.test(name))throw new HttpError(400,'导入名称无效');
      abort.throwIfAborted();if(this.management.security.resourceConfiguration(projectId)!==policy)throw new HttpError(409,'项目策略已变化，请重新预览');
      plan={id:id(),projectId,name,notice:source.notice,policy,expires:Date.now()+lifetime,hexhub,candidates:[]};
      for(const [index,raw] of source.records.entries()){abort.throwIfAborted();plan.candidates.push(this.candidate(projectId,raw,index,hexhub));}
      writeFileSync(join(this.directory(),plan.id+'.json'),JSON.stringify(plan),{mode:0o600,flag:'wx'});
      return {planId:plan.id,name:plan.name,notice:plan.notice,resources:plan.candidates.map(candidate=>candidate.row)};
    }catch(error){if(plan)this.cleanup(plan);if(abort.aborted)throw new HttpError(408,'资源识别已取消');throw error;}
    finally{this.pending.delete(controller);}
  }
  private idle(projectId:string) {
    if(this.management.navigation.busy(projectId)||this.store.list<any>('superWorkers').some(worker=>worker.projectId===projectId&&['active','queued'].includes(worker.state))||
      this.store.list<any>('superInputs').some(input=>input.projectId===projectId&&input.disposition==='pending')||
      this.store.list<any>('terminals').some(terminal=>this.store.get<any>('sessions',terminal.sessionId)?.projectId===projectId&&!['closed','disconnected','failed'].includes(terminal.status)))
      throw new HttpError(409,'请先停止项目活动任务和终端，再补充已有连接的登录信息');
  }
  async commit(projectId:string,input:ImportRecord,signal:AbortSignal) {
    if(this.closed)throw new HttpError(503,'资源导入正在停止');
    this.management.security.resourceConfiguration(projectId);
    const plan=this.readPlan(input.planId);if(plan.projectId!==projectId)throw new HttpError(403,'导入计划不属于此项目');
    if(plan.expires<Date.now())throw new HttpError(410,'导入预览已过期，请重新识别');
    if(Object.keys(input).some(key=>!['planId','indexes'].includes(key))||!Array.isArray(input.indexes)||!input.indexes.length||input.indexes.length>1000||input.indexes.some((index:unknown)=>!Number.isSafeInteger(index)||Number(index)<0||Number(index)>=plan.candidates.length)||new Set(input.indexes).size!==input.indexes.length)throw new HttpError(400,'请选择有效且不重复的资源行');
    const indexes:number[]=[...input.indexes].sort((a,b)=>a-b),selection=digest(indexes);
    const selected=indexes.map(index=>plan.candidates[index]);if(selected.some(candidate=>candidate.row.error||!candidate.resource))throw new HttpError(400,'所选资源含无效配置，请重新选择');
    const replay=()=>{
      const receipt=this.store.get<Receipt>('resourceImportReceipts',plan.id);if(!receipt)return;
      if(receipt.projectId!==projectId||receipt.selection!==selection)throw new HttpError(409,'该预览已经导入，请重新识别后选择其他资源');
      return {createdCount:0,updatedCount:0,skippedCount:receipt.count};
    };
    const prior=replay();if(prior)return prior;
    const controller=new AbortController();this.pending.add(controller);const abort=AbortSignal.any([signal,controller.signal]);
    try{
      if(plan.hexhub){
        const current=await hexHubImportSource(abort,this.options),source=new Map<string,string[]>();
        for(const record of current.records){const key=hexHubIdentity(record);source.set(key,[...(source.get(key)??[]),digest(record)]);}
        for(const candidate of selected){const matches=source.get(candidate.sourceIdentity!);if(matches?.length!==1||matches[0]!==candidate.sourceDigest)throw new HttpError(409,'HexHub 清单或登录信息已变化，请重新读取并预览');}
      }
      abort.throwIfAborted();const concurrent=replay();if(concurrent)return concurrent;
      if(this.management.security.resourceConfiguration(projectId)!==plan.policy)throw new HttpError(409,'项目策略已变化，请重新预览');
      const operations:PreparedResourceImport[]=[],virtual:Resource[]=[],result={createdCount:0,updatedCount:0,skippedCount:0};
      for(const candidate of selected){
        for(const [ref,pin] of Object.entries(candidate.files))if(this.filePin(ref)!==pin)throw new HttpError(409,'导入凭据已变化，请重新预览');
        const resource=candidate.resource!;
        if(candidate.target){
          const current=this.store.require<Resource>('resources',candidate.target);
          if(digest(current)!==candidate.previous)throw new HttpError(409,'已有资源在预览后已变化，请重新识别');
          if(digest(current)===digest(resource)){result.skippedCount++;continue;}
          const pending=operations.find(operation=>operation.resource.id===resource.id);
          if(pending){if(!this.complete(pending.resource)&&this.complete(resource))pending.resource=resource;result.skippedCount++;continue;}
          this.idle(projectId);this.management.security.resourceConfiguration(projectId,current.id);
          operations.push({resource,folder:'',previous:candidate.previous});result.updatedCount++;
        }else{
          const duplicate=this.match(projectId,resource.kind,configOf(resource))??virtual.find(other=>identity(other.kind,configOf(other))===identity(resource.kind,configOf(resource)));
          if(duplicate){
            if(!virtual.includes(duplicate)&&!this.complete(duplicate))throw new HttpError(409,'此端点已有新的不完整连接，请重新预览');
            if(virtual.includes(duplicate)&&!this.complete(duplicate)&&this.complete(resource)){
              const operation=operations.find(operation=>operation.resource.id===duplicate.id)!;
              operation.resource={...resource,id:duplicate.id,name:duplicate.name};virtual[virtual.indexOf(duplicate)]=operation.resource;
            }
            result.skippedCount++;continue;
          }
          operations.push({resource,folder:candidate.row.folder});virtual.push(resource);result.createdCount++;
        }
      }
      this.management.applyImports(projectId,operations,()=>this.store.put('resourceImportReceipts',plan.id,{projectId,selection,count:indexes.length} satisfies Receipt));
      try{this.cleanup(plan);}catch{/* Committed writes and receipt remain durable. */}
      return result;
    }catch(error){if(abort.aborted)throw new HttpError(408,'资源导入已取消');throw error;}
    finally{this.pending.delete(controller);}
  }
  close(){this.closed=true;for(const controller of this.pending)controller.abort();}
}
