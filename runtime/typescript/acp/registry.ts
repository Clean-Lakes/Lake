import { access, readFile, realpath } from 'node:fs/promises';
import { join, isAbsolute, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import {createHash} from 'node:crypto';
import { externalAgentId, externalAgentIds, externalProducts } from './catalog';
import type { CliAgentId, CliAgentProfile, CodexAgentProfile, CodexConnectionProbe, CodexModelOption, ExternalAgentId, ExternalAgentProfile, ExternalAgentStatus } from './types';
import { HttpError, LakeStore, now } from '../store';
import { privateFile, privatePath } from './private';
import { codexCatalogRevision, codexModelCatalog, codexStartupArgs, isCodexModelId, isCodexReasoningEffort, tomlValue } from './codex-profile';
import {CodexLocalSource,codexHomePresent} from './codex-local';
import {discoverCodexRuntime,validateCodexNode} from './runtime-paths';
import {codexConnectionVersion} from './types';
import {claudeGatewayConfig,cliExecutable,cliRuntimeKinds,cliSecretId,cliSource,isCliAuthentication,isCliModelId,isCliReasoningEffort} from './cli-profile';
import {cliDefaultAuthentication} from '../../../web-agent/shared/external-agents';

function projectOverride(input:unknown,current:string|undefined,isValid:(value:unknown)=>value is string,invalid:string){
  if(input===undefined)return current;
  if(input===null)return undefined;
  if(!isValid(input))throw new HttpError(400,invalid);
  return input;
}

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
  get(projectId:string,agent:'codex'):CodexAgentProfile;
  get(projectId:string,agent:unknown):ExternalAgentProfile;
  get(projectId: string, agent: unknown): ExternalAgentProfile {
    const id = externalAgentId(agent), key = this.key(projectId, id);
    if(id!=='codex')return this.getCli(projectId,id,key);
    const source=this.source(),current=this.store.get<any>('acpProfiles',key);
    if(current&&![1,2,3].includes(current.schemaVersion))throw new HttpError(409,'外部 Agent 配置版本不受当前版本支持');
    if(current&&(current.schemaVersion!==3||current.runtimeKind!=='codex-app-server'||current.sourceFingerprint!==source.fingerprint)){
      const profile:ExternalAgentProfile={schemaVersion:3,runtimeKind:'codex-app-server',id,projectId,revision:current.revision+1,enabled:current.enabled,
        nodePath:current.nodePath,npmPath:current.npmPath,modelOverride:current.modelOverride,reasoningEffortOverride:current.reasoningEffortOverride,
        authentication:'codex-local',sourceFingerprint:source.fingerprint,updatedAt:now()};
      return this.store.put('acpProfiles',key,profile);
    }
    return current??{schemaVersion:3,runtimeKind:'codex-app-server',id,projectId,revision:0,enabled:false,authentication:'codex-local',sourceFingerprint:source.fingerprint,updatedAt:now()};
  }
  private getCli(projectId:string,id:CliAgentId,key:string):CliAgentProfile {
    const current=this.store.get<CliAgentProfile|(Omit<CliAgentProfile,'schemaVersion'> & {schemaVersion:3})>('acpProfiles',key);
    const defaultAuthentication=cliDefaultAuthentication[id];
    if(current&&(
      ![3,4].includes(current.schemaVersion)||current.runtimeKind!==cliRuntimeKinds[id]||
      !isCliAuthentication(id,current.authentication)||
      current.authentication==='claude-custom-api'&&!current.claudeGateway
    ))
      throw new HttpError(409,'外部 Agent 配置版本不受当前版本支持');
    const settings={projectId,id,executablePath:current?.executablePath,
      authentication:current?.authentication??defaultAuthentication,claudeGateway:current?.claudeGateway};
    const source=cliSource(this.store.home,settings);
    const authentication=current?.schemaVersion===3&&!source.keyConfigured?defaultAuthentication:
      current?.authentication??defaultAuthentication;
    const sourceFingerprint=authentication===current?.authentication||!current?source.fingerprint:
      cliSource(this.store.home,{...settings,authentication}).fingerprint;
    if(current){
      if(current.schemaVersion===4&&current.sourceFingerprint===sourceFingerprint)return current;
      const revision=current.revision+Number(current.sourceFingerprint!==sourceFingerprint);
      return this.store.put('acpProfiles',key,{...current,schemaVersion:4,authentication,sourceFingerprint,revision,updatedAt:now()});
    }
    return {schemaVersion:4,id,projectId,runtimeKind:cliRuntimeKinds[id],revision:0,enabled:false,authentication,sourceFingerprint,updatedAt:now()};
  }
  revision(projectId: string) { return externalAgentIds.map(id => this.get(projectId, id).revision).join(':'); }
  // Retain the installed engine location across the transport migration.
  runtimeRoot() { return join(this.store.home, 'external-agents', 'adapters', 'codex'); }
  engineEntry() { return join(this.runtimeRoot(), 'node_modules', '@openai', 'codex', 'bin', 'codex.js'); }
  async list(projectId: string): Promise<ExternalAgentStatus[]> {
    return Promise.all(externalAgentIds.map(async id => {
      const profile = this.get(projectId, id);
      if(profile.id!=='codex')return this.cliStatus(profile);
      let installed = false;
      try {
        const engine = JSON.parse(await readFile(join(this.runtimeRoot(), 'node_modules/@openai/codex/package.json'), 'utf8'));
        await access(this.engineEntry());await access(profile.nodePath!);
        installed = engine.version === externalProducts.codex.version;
      } catch { /* unavailable */ }
      const probe=this.probe(projectId,id),source=this.source();
      const current=probe?.revision===profile.revision&&probe.authentication==='codex-local';
      const transportReady=installed&&current&&probe.ready===true;
      const localModel=current?(probe.localModel??probe.model):undefined;
      const models=current?probe.models??[]:[];
      const modelOptions=[...new Set([...models.map(model=>model.id),localModel,profile.modelOverride].filter(isCodexModelId))];
      const modelEffortOptions=Object.fromEntries(models.map(model=>[model.id,model.reasoningEfforts]));
      const model=profile.modelOverride??localModel;
      const assignmentBlocker=!profile.enabled?'请在「模型配置」中启用 Codex 并保存':
        process.platform!=='darwin'?'当前平台的 Codex 执行尚未开放':source.error??
        (!codexHomePresent(source.home)?'未找到本机 Codex 配置目录，请先在本机 Codex 完成登录':
        !installed?'尚未安装，请启用后自动准备 Codex 引擎':
        !transportReady?(current&&probe.message||'正在读取本机 Codex 登录与连接状态'):
        !probe.authenticated?'本机 Codex 尚未登录，请先在 Codex 中完成登录后重新连接':undefined);
      return {...profile,name:externalProducts[id].name,installed,transportReady,assignmentReady:!assignmentBlocker,assignmentBlocker,
        configPath:join(source.home,'config.toml'),authMode:current?probe.authMode:undefined,
        model:current?probe.model:undefined,localModel,defaultTaskModel:transportReady&&probe.authenticated?model:undefined,
        modelOptions,modelEffortOptions,reasoningEffortOptions:models.find(option=>option.id===model)?.reasoningEfforts??[],
        modelProvider:current?probe.modelProvider:undefined,reasoningEffort:current?probe.reasoningEffort:undefined,
        message:current?probe.message:undefined,capabilities:current?probe.capabilities:undefined};
    }));
  }
  private cliStatus(profile:CliAgentProfile):ExternalAgentStatus {
    const {id,projectId}=profile;
    const {executable,keyConfigured}=cliSource(this.store.home,profile);
    const probe=this.probe(projectId,id);
    const current=probe?.revision===profile.revision&&probe.authentication===profile.authentication?probe:undefined;
    const name=externalProducts[id].name;
    const transportReady=!!executable&&current?.ready===true;
    const selectedModel=profile.modelOverride??current?.localModel??current?.model;
    const modelOptions=current?.models?.map(model=>model.id);
    const selectedOption=current?.models?.find(model=>model.id===selectedModel);
    const reasoningEffortOptions=selectedOption?.reasoningEfforts;
    const effortUnavailable=profile.reasoningEffortOverride&&!reasoningEffortOptions?.includes(profile.reasoningEffortOverride);
    const assignmentBlocker=!profile.enabled?`请启用 ${name} 并保存`:
      process.platform!=='darwin'?'当前平台尚未开放本机 CLI 执行':!executable?`未找到 ${name} CLI，请安装或填写路径`:
      !current?`正在检测 ${name} 连接`:!transportReady||!current.authenticated?current.message??`${name} 连接不可用`:
      id==='antigravity'&&profile.modelOverride&&profile.modelOverride!==current.localModel&&
      !modelOptions?.includes(profile.modelOverride)?'所选模型在当前账号下不可用，请重新选择':
      profile.authentication==='claude-custom-api'&&!selectedModel?'请选择第三方模型并保存':
      effortUnavailable?'所选模型的思考强度已变化，请重新选择':undefined;
    const {googleLoginId:_login,...preferences}=profile;
    return {...preferences,name,installed:!!executable,transportReady,assignmentReady:!assignmentBlocker,assignmentBlocker,
      detectedExecutable:executable?.path,cliVersion:current?.cliVersion,keyConfigured,
      authMode:current?.authMode??'none',
      localModel:current?.localModel,model:current?.model,defaultTaskModel:selectedModel,
      modelOptions,modelEffortOptions:current?.models&&Object.fromEntries(current.models.map(model=>[model.id,model.reasoningEfforts])),
      reasoningEffortOptions,reasoningEffort:effortUnavailable?undefined:profile.reasoningEffortOverride??selectedOption?.defaultReasoningEffort,
      message:current?.message};
  }
  probe(projectId:string,agent:ExternalAgentId) {
    const probe = this.store.get<CodexConnectionProbe>('acpProbes',this.key(projectId,agent));
    // Retry older failures once with the corrected startup configuration.
    return agent==='codex'&&probe?.ready===false&&probe.connectionVersion!==codexConnectionVersion?undefined:probe;
  }
  save(projectId:string,agent:'codex',input:Record<string,unknown>):Promise<CodexAgentProfile>;
  save(projectId:string,agent:unknown,input:Record<string,unknown>):Promise<ExternalAgentProfile>;
  async save(projectId: string, agent: unknown, input: Record<string, unknown>) {
    const id=externalAgentId(agent), key=this.key(projectId,id), previous=this.mutations.get(key)??Promise.resolve();
    const work=previous.catch(()=>{}).then(async()=>{
      const current=this.get(projectId,id);
      const stale='外部 Agent 配置已变化，请刷新后重试';
      if(input.expectedRevision!==current.revision)throw new HttpError(409,stale);
      if(typeof input.enabled!=='boolean')throw new HttpError(400,'需要明确是否启用 Agent');
      if(current.id!=='codex')return this.saveCli(current,input,key);
      if(input.apiKey!==undefined)throw new HttpError(400,'Codex 已复用本机登录，请在本机 Codex 中管理认证');
      if(input.model!==undefined)throw new HttpError(400,'请通过项目的 Codex 模型选项设置模型');
      const modelOverride=projectOverride(input.modelOverride,current.modelOverride,isCodexModelId,'Codex 模型 ID 无效');
      const reasoningEffortOverride=projectOverride(input.reasoningEffortOverride,current.reasoningEffortOverride,isCodexReasoningEffort,'Codex 思考强度无效');
      if(reasoningEffortOverride&&(modelOverride!==current.modelOverride||reasoningEffortOverride!==current.reasoningEffortOverride)){
        const probe=this.probe(projectId,id);
        const model=modelOverride??probe?.localModel??probe?.model;
        const efforts=probe?.revision===current.revision?probe.models?.find(option=>option.id===model)?.reasoningEfforts:undefined;
        if(efforts?.length&&!efforts.includes(reasoningEffortOverride))throw new HttpError(400,'所选模型不支持这个思考强度');
      }
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
      if(this.get(projectId,id).revision!==current.revision)throw new HttpError(409,stale);
      const profile:ExternalAgentProfile={...current,nodePath,npmPath,modelOverride,reasoningEffortOverride,
        enabled:input.enabled,revision:current.revision+1,updatedAt:now()};
      return this.store.put('acpProfiles',key,profile);
    });
    this.mutations.set(key,work);
    try{return await work;}finally{if(this.mutations.get(key)===work)this.mutations.delete(key);}
  }
  private async saveCli(current:CliAgentProfile,input:Record<string,unknown>,key:string){
    const {id}=current;
    if(input.model!==undefined||input.nodePath!==undefined||input.npmPath!==undefined)
      throw new HttpError(400,'请使用当前 CLI 支持的配置项');
    const apiKey=input.apiKey;
    const inferredAuthentication=typeof apiKey==='string'&&current.authentication!=='claude-custom-api'?'cli-api-key':current.authentication;
    const authentication=input.authentication===undefined?inferredAuthentication:input.authentication;
    if(!isCliAuthentication(id,authentication))throw new HttpError(400,'请选择当前执行器支持的登录方式');
    let claudeGateway=current.claudeGateway;
    if(input.claudeGateway!==undefined){
      if(authentication!=='claude-custom-api')throw new HttpError(400,'请选择自定义 API 后设置服务地址');
      claudeGateway=claudeGatewayConfig(input.claudeGateway);
    }
    if(authentication==='claude-custom-api'&&!claudeGateway)throw new HttpError(400,'请填写自定义 API 基础地址');
    const gatewayChanged=(authentication==='claude-custom-api'||current.authentication==='claude-custom-api')&&
      (authentication!==current.authentication||claudeGateway?.baseURL!==current.claudeGateway?.baseURL||
        claudeGateway?.credentialHeader!==current.claudeGateway?.credentialHeader);
    const modelOverride=projectOverride(input.modelOverride,gatewayChanged?undefined:current.modelOverride,isCliModelId,'模型 ID 无效');
    const reasoningEffortOverride=projectOverride(input.reasoningEffortOverride,gatewayChanged?undefined:current.reasoningEffortOverride,isCliReasoningEffort,'思考强度无效');
    if(reasoningEffortOverride&&(gatewayChanged||modelOverride!==current.modelOverride||reasoningEffortOverride!==current.reasoningEffortOverride)){
      const probe=this.probe(current.projectId,id);
      const model=modelOverride??probe?.localModel??probe?.model;
      if(gatewayChanged||probe?.revision!==current.revision||!probe.ready||probe.authentication!==current.authentication||
        !probe.models?.find(option=>option.id===model)?.reasoningEfforts.includes(reasoningEffortOverride))
        throw new HttpError(400,'所选模型不支持这个思考强度');
    }
    let executablePath=current.executablePath;
    if(input.executablePath!==undefined){
      const path=input.executablePath;
      if(path==='')executablePath=undefined;
      else {
        if(typeof path!=='string'||!isAbsolute(path)||/[\0\r\n]/.test(path)||!cliExecutable(this.store.home,id,path))
          throw new HttpError(400,'CLI 路径必须指向可执行文件');
        executablePath=path;
      }
    }
    if(this.get(current.projectId,id).revision!==current.revision)throw new HttpError(409,'外部 Agent 配置已变化，请刷新后重试');
    const settings={...current,authentication,claudeGateway,executablePath,modelOverride,reasoningEffortOverride,enabled:input.enabled===true};
    if(apiKey!==undefined){
      if(authentication!=='cli-api-key'&&authentication!=='claude-custom-api')throw new HttpError(400,'请选择 API Key 登录方式后保存凭据');
      if(apiKey!==null&&(typeof apiKey!=='string'||!apiKey||apiKey.length>4096||/[^\x21-\x7e]/.test(apiKey)))throw new HttpError(400,'API Key 格式无效');
      await this.store.secret(cliSecretId(settings),apiKey);
    }
    const verified=this.get(current.projectId,id);
    const profile:CliAgentProfile={...settings,sourceFingerprint:cliSource(this.store.home,settings).fingerprint,
      revision:Math.max(verified.revision,current.revision+1),updatedAt:now()};
    return this.store.put('acpProfiles',key,profile);
  }
  async validateNode(path:string){await validateCodexNode(path);}
  async prepareHome(profile:ExternalAgentProfile){
    const home=await privatePath(this.store.home,'external-agents','profiles',profile.projectId,profile.id);
    await privatePath(home,'state');await privatePath(home,'logs');
    return home;
  }
  private async prepareModelCatalog(home:string,model:string,option?:CodexModelOption){
    const contents=JSON.stringify(codexModelCatalog(model,option));
    const file='models-'+createHash('sha256').update(contents).digest('hex')+'.json';
    await privateFile(home,file,contents);
    return join(home,file);
  }
  private async launchConfiguration(profile:CodexAgentProfile,signal:AbortSignal,discoverModels:boolean,model?:string){
    const source=this.source();if(source.error)throw new HttpError(409,source.error);
    if(!codexHomePresent(source.home))throw new HttpError(409,'未找到本机 Codex 配置目录，请先在 Codex 中完成登录');
    const requested=model??profile.modelOverride;
    if(requested!==undefined&&!isCodexModelId(requested))throw new HttpError(400,'Codex 模型 ID 无效');
    const home=await this.prepareHome(profile),engine=this.engineEntry();
    const probe=this.probe(profile.projectId,profile.id);
    const current=probe?.revision===profile.revision&&probe.authentication==='codex-local'?probe:undefined;
    // This process only reads config, account and model metadata. Actual
    // threads always start with a sanitized, immutable catalog for their model.
    const config=await this.local.inspect(profile.nodePath!,engine,home,codexStartupArgs(home,source.mcpIds,source.hooks),signal,
      {discoverModels,knownDefaultModel:current?.localModel});
    const selected=requested??config.model;
    const models=config.models??current?.models??[];
    const option=models.find(item=>item.id===selected);
    const effort=profile.reasoningEffortOverride;
    const catalogPath=await this.prepareModelCatalog(home,selected,option);
    const overrides=['-c','model='+tomlValue(selected),
      ...(effort===undefined?[]:['-c','model_reasoning_effort='+tomlValue(effort)])];
    if(this.get(profile.projectId,profile.id).revision!==profile.revision)throw new HttpError(409,'本机 Codex 配置或账号已变化，请重新连接');
    return {home,catalogPath,localModel:config.model,models,command:profile.nodePath!,
      args:[engine,...codexStartupArgs(home,config.mcpIds,config.hooks,catalogPath),...overrides,'app-server'],
      disabledMcp:Object.fromEntries(config.mcpIds.map(name=>[name,{enabled:false}])),environment:config.environment,
      observed:{model:selected,modelProvider:config.provider,reasoningEffort:effort??config.reasoningEffort??option?.defaultReasoningEffort,
        authenticated:config.authenticated,authMode:config.authMode}};
  }

  prepareConnection(profile:CodexAgentProfile,signal:AbortSignal) {
    return this.launchConfiguration(profile,signal,true);
  }

  prepareLaunch(profile:CodexAgentProfile,signal:AbortSignal,model?:string) {
    return this.launchConfiguration(profile,signal,false,model);
  }

  async install(projectId: string, agent: unknown, npmPath: unknown, signal: AbortSignal) {
    const profile=this.get(projectId,agent);
    if(profile.id!=='codex')throw new HttpError(400,`请通过 ${externalProducts[profile.id].name} 的官方安装方式更新 CLI`);
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
