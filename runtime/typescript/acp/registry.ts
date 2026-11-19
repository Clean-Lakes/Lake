import { access, readFile, realpath } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import {createHash} from 'node:crypto';
import { externalAgentId, externalAgentIds, externalProducts } from './catalog';
import type { ExternalAgentId, ExternalAgentProfile, ExternalAgentStatus } from './types';
import { HttpError, LakeStore, now } from '../store';
import { privateFile, privatePath } from './private';
import { codexCatalog, codexCatalogRevision, codexModels, codexStartupArgs,tomlValue } from './codex-profile';
import {CodexLocalSource,codexHomePresent} from './codex-local';
import {discoverCodexRuntime,validateCodexNode} from './runtime-paths';

export class ExternalAgentRegistry {
  private mutations = new Map<string, Promise<unknown>>();
  private installation?: Promise<unknown>;
  readonly local:CodexLocalSource;
  constructor(readonly store: LakeStore,options:{codexHome?:string;registerSecret?:(value:string)=>void}={}) {
    this.local=new CodexLocalSource(options.codexHome,options.registerSecret??(()=>{}));
    for(const profile of store.list<any>('acpProfiles'))if(profile.id==='codex'&&[1,2].includes(profile.schemaVersion))this.get(profile.projectId,'codex');
  }
  source(){
    try{
      const source=this.local.current();
      // A probe only applies to the engine and the Lake model catalog it tested.
      const fingerprint=createHash('sha256').update(source.fingerprint+'\0'+externalProducts.codex.version+'\0'+codexCatalogRevision).digest('hex');
      return {...source,fingerprint,error:undefined as string|undefined};
    }
    catch(error){return {home:this.local.home,fingerprint:createHash('sha256').update('unavailable:'+this.local.home).digest('hex'),environment:{} as NodeJS.ProcessEnv,mcpIds:[],hooks:{},error:error instanceof Error?error.message:'无法读取本机 Codex 配置'};}
  }
  private key(projectId: string, id: ExternalAgentId) { this.store.require('projects', projectId); return projectId + ':' + id; }
  get(projectId: string, agent: unknown): ExternalAgentProfile {
    const id = externalAgentId(agent), key = this.key(projectId, id);
    const source=this.source(),current=this.store.get<any>('acpProfiles',key);
    if(current&&![1,2,3].includes(current.schemaVersion))throw new HttpError(409,'外部 Agent 配置版本不受当前版本支持');
    if(current&&(current.schemaVersion!==3||current.runtimeKind!=='codex-app-server'||current.sourceFingerprint!==source.fingerprint)){
      const profile:ExternalAgentProfile={schemaVersion:3,runtimeKind:'codex-app-server',id,projectId,revision:current.revision+1,enabled:current.enabled,
        nodePath:current.nodePath,npmPath:current.npmPath,authentication:'codex-local',sourceFingerprint:source.fingerprint,updatedAt:now()};
      return this.store.put('acpProfiles',key,profile);
    }
    return current??{schemaVersion:3,runtimeKind:'codex-app-server',id,projectId,revision:0,enabled:false,authentication:'codex-local',sourceFingerprint:source.fingerprint,updatedAt:now()};
  }
  revision(projectId: string) { return externalAgentIds.map(id => this.get(projectId, id).revision).join(':'); }
  // Retain the installed engine location across the transport migration.
  runtimeRoot() { return join(this.store.home, 'external-agents', 'adapters', 'codex'); }
  engineEntry() { return join(this.runtimeRoot(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'); }
  async list(projectId: string): Promise<ExternalAgentStatus[]> {
    return Promise.all(externalAgentIds.map(async id => {
      const profile = this.get(projectId, id);
      let installed = false;
      try {
        const engine = JSON.parse(await readFile(join(this.runtimeRoot(), 'node_modules/@openai/codex/package.json'), 'utf8'));
        await access(this.engineEntry());await access(profile.nodePath!);
        installed = engine.version === externalProducts.codex.version;
      } catch { /* unavailable */ }
      const probe=this.probe(projectId,id),source=this.source();
      const current=probe?.revision===profile.revision&&probe.authentication==='codex-local';
      const transportReady=installed&&current&&probe.ready===true;
      const assignmentBlocker=!profile.enabled?'尚未启用，请在 Agent 设置中启用并保存':
        process.platform!=='darwin'?'当前平台的 Codex 执行尚未开放':source.error??
        (!codexHomePresent(source.home)?'未找到本机 Codex 配置目录，请先在本机 Codex 完成登录':
        !installed?'尚未安装，请启用后自动准备 Codex 引擎':
        !transportReady?(current&&probe.message||'正在读取本机 Codex 登录与连接状态'):
        !probe.authenticated?'本机 Codex 尚未登录，请先在 Codex 中完成登录后重新连接':undefined);
      return {...profile,name:externalProducts[id].name,installed,transportReady,assignmentReady:!assignmentBlocker,assignmentBlocker,
        configPath:join(source.home,'config.toml'),authMode:current?probe.authMode:undefined,
        model:current?probe.model:undefined,modelProvider:current?probe.modelProvider:undefined,reasoningEffort:current?probe.reasoningEffort:undefined,
        message:current?probe.message:undefined,capabilities:current?probe.capabilities:undefined};
    }));
  }
  probe(projectId:string,agent:ExternalAgentId){return this.store.get<any>('acpProbes',this.key(projectId,agent));}
  async save(projectId: string, agent: unknown, input: Record<string, unknown>) {
    const id=externalAgentId(agent), key=this.key(projectId,id), previous=this.mutations.get(key)??Promise.resolve();
    const work=previous.catch(()=>{}).then(async()=>{
      const current=this.get(projectId,id);
      if(input.expectedRevision!==current.revision)throw new HttpError(409,'外部 Agent 配置已变化，请刷新后重试');
      if(typeof input.enabled!=='boolean')throw new HttpError(400,'需要明确是否启用 Agent');
      let nodePath=current.nodePath;
      let npmPath=current.npmPath;
      if(input.nodePath!==undefined){
        if(input.nodePath==='')nodePath=undefined;
        else {
          if(typeof input.nodePath!=='string'||!isAbsolute(input.nodePath)||/[\0\r\n]/.test(input.nodePath))throw new HttpError(400,'Node 需要准确绝对路径');
          nodePath=await realpath(input.nodePath);await this.validateNode(nodePath);
        }
      }
      if(input.npmPath!==undefined){
        if(input.npmPath==='')npmPath=undefined;
        else if(typeof input.npmPath!=='string'||!isAbsolute(input.npmPath)||/[\0\r\n]/.test(input.npmPath))throw new HttpError(400,'npm 需要准确绝对路径');
        else npmPath=await realpath(input.npmPath);
      }
      if(input.autoDetect===true||input.enabled&&(!nodePath||!npmPath))({nodePath,npmPath}=await discoverCodexRuntime(nodePath,npmPath));
      if(input.apiKey!==undefined)throw new HttpError(400,'Codex 已复用本机登录，请在本机 Codex 中管理认证');
      if(input.model!==undefined)throw new HttpError(400,'模型跟随本机 Codex 配置，请在 Codex 中修改');
      const profile:ExternalAgentProfile={...current,nodePath,npmPath,enabled:input.enabled,revision:current.revision+1,updatedAt:now()};
      return this.store.put('acpProfiles',key,profile);
    });
    this.mutations.set(key,work);
    try{return await work;}finally{if(this.mutations.get(key)===work)this.mutations.delete(key);}
  }
  async validateNode(path:string){await validateCodexNode(path);}
  async prepareHome(profile:ExternalAgentProfile){
    const home=await privatePath(this.store.home,'external-agents','profiles',profile.projectId,profile.id);
    await privatePath(home,'state');await privatePath(home,'logs');
    await privateFile(home,'models.json',JSON.stringify(codexCatalog));return home;
  }
  async prepareLaunch(profile:ExternalAgentProfile,signal:AbortSignal,model?:string){
    if(model!==undefined&&!codexModels.includes(model))throw new HttpError(400,'该模型不在当前 Codex 兼容目录中');
    const source=this.source();if(source.error)throw new HttpError(409,source.error);
    if(!codexHomePresent(source.home))throw new HttpError(409,'未找到本机 Codex 配置目录，请先在 Codex 中完成登录');
    const home=await this.prepareHome(profile),engine=join(this.runtimeRoot(),'node_modules/@openai/codex/bin/codex.js');
    const modelArgs=model===undefined?[]:['-c','model='+tomlValue(model)];
    const config=await this.local.inspect(profile.nodePath!,engine,home,[...codexStartupArgs(home,source.mcpIds,source.hooks),...modelArgs],signal);
    if(!codexModels.includes(config.model))throw new HttpError(409,'本机 Codex 模型尚未通过当前工具兼容验证：'+config.model);
    if(model!==undefined&&config.model!==model)throw new HttpError(409,'未能确认专员指定的 Codex 模型，未启动任务');
    if(this.get(profile.projectId,profile.id).revision!==profile.revision)throw new HttpError(409,'本机 Codex 配置或账号已变化，请重新连接');
    return {home,command:profile.nodePath!,args:[engine,...codexStartupArgs(home,config.mcpIds,config.hooks),...modelArgs,'app-server'],
      disabledMcp:Object.fromEntries(config.mcpIds.map(name=>[name,{enabled:false}])),environment:config.environment,
      observed:{model:config.model,modelProvider:config.provider,reasoningEffort:config.reasoningEffort,authenticated:config.authenticated,authMode:config.authMode}};
  }

  async install(projectId: string, agent: unknown, npmPath: unknown, signal: AbortSignal) {
    const profile=this.get(projectId,agent);
    if(this.installation)throw new HttpError(409,'Codex 引擎正在安装');
    npmPath=npmPath??profile.npmPath;
    if(!profile.nodePath||typeof npmPath!=='string'||!isAbsolute(npmPath)||/[\0\r\n]/.test(npmPath))throw new HttpError(400,'未识别到 Node/npm，请重新启用自动识别或检查高级设置');
    const node=profile.nodePath,npm=await realpath(npmPath);await this.validateNode(node);
    if(this.installation||this.store.list<any>('acpRuns').some(run=>run.agent==='codex'&&['starting','running'].includes(run.state)))throw new HttpError(409,'请等待 Codex 当前运行结束后再安装引擎');
    const work=(async()=>{
      const root=await privatePath(this.store.home,'external-agents','adapters','codex');
      const cache=await privatePath(this.store.home,'external-agents','npm-cache');
      // Install only the pinned official provider runtime; no protocol wrapper.
      await new Promise<void>((resolve,reject)=>{
        const proc=spawn(node,[npm,'install','--prefix',root,'--ignore-scripts','--no-audit','--no-fund','--save-exact',`@openai/codex@${externalProducts.codex.version}`],
          {env:{PATH:dirname(node)+(process.platform==='win32'?';':':')+(process.env.PATH??''),HOME:this.store.home,npm_config_cache:cache},stdio:'ignore',signal,shell:false});
        proc.once('error',reject);proc.once('exit',code=>code===0?resolve():reject(new Error('Codex 引擎安装失败，请检查运行时和网络')));
      });
      const manifest=JSON.parse(await readFile(join(root,'node_modules/@openai/codex/package.json'),'utf8'));
      if(manifest.version!==externalProducts.codex.version)throw new Error('Codex 引擎版本与固定版本不符');
      return {installed:true,version:manifest.version};
    })();this.installation=work;
    try{return await work;}finally{this.installation=undefined;}
  }
}
