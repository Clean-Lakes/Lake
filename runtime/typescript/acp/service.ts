import { chmod,lstat,mkdtemp,readFile,rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { isSea } from 'node:sea';
import { LakeStore,HttpError,id,now } from '../store';
import { digest } from '../tasks';
import {TaskDeadlineReached,watchTaskDeadline} from '../task-deadline';
import type {AgentActivity,AgentConnection,AgentLaunch,ObserveAgentModel,ScopedHttpMcp,ScopedStdioMcp} from './client';
import {codexToolDetail,commandLimit,outputLine} from './codex-activity';
import {CodexAppServer} from './codex-app-server';
import {ClaudeCode,claudeLocalAccount,discoverClaudeModels} from './claude-code';
import {Antigravity,antigravityLoginRequired} from './antigravity';
import {antigravityAuthorizationCode,launchAntigravityLogin} from './antigravity-login';
import {antigravityCredentials,cliEnvironment,cliSecretId,cliVersion,isCliModelId} from './cli-profile';
import { ExternalAgentRegistry } from './registry';
import { externalAgentId,externalControlTools,externalProducts } from './catalog';
import {externalAgentName,type AntigravityGoogleAuthorization,type ClaudeGateway} from '../../../web-agent/shared/external-agents';
import { openHttpToolBridge,openToolBridge } from './bridge';
import {privatePath} from './private';
import {codexConfig,tomlValue} from './codex-profile';
import {ExternalPublicText} from './public-text';
import type { CliAgentProfile,CodexAgentProfile,CodexConnectionProbe,CodexModelOption,ExternalActor,ExternalEvent,ExternalResult,ExternalRun } from './types';
import {cliCatalogVersion,codexConnectionVersion,maxExternalConversationRuns} from './types';
import type {SpecialistReplyAuthor} from '../../../web-agent/shared/contracts';
import {specialistClosingMessageIds,legacyCommandBodies} from '../codex-conversation';

function ownLauncher(flag:string,args:string[]=[]){return {executable:process.execPath,args:isSea()?[flag,...args]:[__filename,flag,...args]};}
type LiveRun={process?:AgentConnection;controller:AbortController;scopeHash:string;conversation:boolean;guard?:()=>void};
type GoogleLogin={
  id:string;
  profile:CliAgentProfile;
  controller:AbortController;
  timer?:ReturnType<typeof setTimeout>;
  directory?:string;
  credentials?:string;
  cli?:ReturnType<typeof launchAntigravityLogin>;
  environment?:Omit<AgentLaunch,'args'>;
  cliVersion?:string;
  authorization?:AntigravityGoogleAuthorization;
  started?:Promise<AntigravityGoogleAuthorization>;
  verifying?:Promise<void>;
  committed?:boolean;
  cleanup?:Promise<void>;
};
const googleExpired='本次 Google 登录已结束，请重新获取授权链接';
const claudeEfforts=['low','medium','high','xhigh','max'] as const;
type ClaudeEffortMetadata={supported?:boolean}&Partial<Record<typeof claudeEfforts[number],{supported?:boolean}>>;
function gatewayHeaders({credentialHeader}:ClaudeGateway,key:string){
  return {'anthropic-version':'2023-06-01',[credentialHeader]:credentialHeader==='authorization'?`Bearer ${key}`:key};
}

async function readGatewayJson(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();
  if(!reader)return undefined;
  const chunks:Uint8Array[]=[];
  let bytes=0;
  try{
    for(;;){
      const {value,done}=await reader.read();
      if(done)break;
      bytes+=value.length;
      if(bytes>4*1024*1024)throw new Error('第三方 API 响应过大');
      chunks.push(value);
    }
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return undefined;}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export class LakeExternalAgents {
  readonly registry:ExternalAgentRegistry;
  private probes=new Map<string,{controller:AbortController;work:Promise<unknown>}>();
  private googleLogins=new Map<string,GoogleLogin>();
  private live=new Map<string,LiveRun>();
  private closingMessages=new Set<string>();
  private legacyCommands=new Map<string,{text:string;worker:string;session:string;task:string;root:string}>();
  constructor(readonly store:LakeStore,readonly redact:(text:string,live?:boolean)=>string,readonly registerSecret:(value:string)=>void,codexHome?:string){
    this.registry=new ExternalAgentRegistry(store,{codexHome,registerSecret});
    for(const run of store.list<ExternalRun>('acpRuns'))if(run.schemaVersion===1){
      this.indexClosingMessages(run);
      this.indexLegacyCommands(run);
      if(['starting','running'].includes(run.state)){
        run.state=run.dispatchPhase==='not_sent'?'interrupted':'unknown';run.updatedAt=now();store.put('acpRuns',run.id,run);
      }
    }
  }
  private indexLegacyCommands(run:ExternalRun){
    if(run.agent!=='codex'||run.purpose!=='worker'||run.childSessionId||run.agentRunId||!run.rootTurnId||!run.taskId||
        !run.events.some(e=>e.displayKind==='command'&&e.detail==='内容已隐藏'))return;
    const receipts=this.store.db.prepare(`SELECT json_extract(o.value,'$.at') AS at,json_extract(o.value,'$.completedAt') AS completedAt,
      json_extract(c.value,'$.command') AS command FROM records o JOIN records c
      ON c.kind='commandExecutions' AND c.id=json_extract(o.value,'$.commandExecutionId')
      WHERE o.kind='superOperations' AND json_extract(o.value,'$.tool')='Bash'
      AND json_extract(o.value,'$.externalRunId')=? AND json_extract(o.value,'$.externalSessionId')=?
      AND json_extract(o.value,'$.projectId')=? AND json_extract(o.value,'$.goalId')=? AND json_extract(o.value,'$.sessionId')=?
      AND json_extract(o.value,'$.generation')=? AND json_extract(o.value,'$.completedAt') IS NOT NULL
      AND json_extract(c.value,'$.taskId')=? AND json_extract(c.value,'$.sessionId')=? AND json_extract(c.value,'$.workerId')=?
      AND json_extract(c.value,'$.generation')=?`).all(run.id,run.externalSessionId??null,run.projectId,run.taskId,run.sessionId,run.generation,
        run.taskId,run.sessionId,run.workerId,run.generation) as {at:string;completedAt:string;command:string}[];
    for(const [id,text] of legacyCommandBodies(run,receipts,this.redact))
      this.legacyCommands.set(id,{text,worker:run.workerId,session:run.sessionId,task:run.taskId,root:run.rootTurnId});
  }
  historicalCommand(id:string,author:SpecialistReplyAuthor|undefined){
    const record=this.legacyCommands.get(id);
    if(record&&author&&record.worker===author.workerId&&record.session===author.sessionId&&record.task===author.taskId&&record.root===author.rootTurnId)
      return this.redact(record.text);
  }
  private indexClosingMessages(run:ExternalRun){
    for(const id of specialistClosingMessageIds(run))this.closingMessages.add(id);
  }
  isClosingMessage(id:string){return this.closingMessages.has(id);}
  private async launch(profile:CodexAgentProfile,directory:string,signal:AbortSignal,mcp?:{command:string;args:string[]},model?:string,purpose:'run'|'probe'='run'):
    Promise<AgentLaunch & {localModel:string;models:CodexModelOption[]}>{
    if(process.platform!=='darwin')throw new HttpError(409,'当前平台的 Codex 工具隔离尚未验证');
    if(!profile.nodePath)throw new HttpError(409,'请先配置 Codex 使用的 Node 运行时');
    const engine=JSON.parse(await readFile(join(this.registry.runtimeRoot(),'node_modules/@openai/codex/package.json'),'utf8'));
    if(engine.version!==externalProducts.codex.version)throw new HttpError(409,'Codex 引擎版本不匹配，请重新安装固定版本');
    await this.registry.validateNode(profile.nodePath);
    const prepared=purpose==='probe'
      ? await this.registry.prepareConnection(profile,signal)
      : await this.registry.prepareLaunch(profile,signal,model);
    const threadConfig={...codexConfig(prepared.home,prepared.catalogPath),
      ...(purpose==='run'?{model:prepared.observed.model,model_reasoning_effort:profile.reasoningEffortOverride}:{}),
      mcp_servers:{...prepared.disabledMcp,...(mcp?{lake:mcp}:{})}};
    return {executable:prepared.command,args:[...prepared.args.slice(0,-1),'-c','mcp_servers='+tomlValue(threadConfig.mcp_servers),'app-server'],
      cwd:directory,observed:prepared.observed,threadConfig,env:{...prepared.environment,TMPDIR:directory},
      models:prepared.models,localModel:prepared.localModel};
  }
  private async inspectCli(profile:CliAgentProfile,directory:string,signal:AbortSignal,googleLoginId?:string){
    if(process.platform!=='darwin')throw new HttpError(409,'当前平台尚未开放本机 CLI 执行');
    const environment=await cliEnvironment(this.store.home,profile,directory,googleLoginId);
    const version=await cliVersion(profile.id,environment,signal);
    return {environment,...version};
  }
  private cliVersionMessage(profile:CliAgentProfile,version:string|undefined){
    const product=externalProducts[profile.id];
    return `${product.name} 需要 ${product.version} 或更新版本${version?`（当前 ${version}）`:''}`;
  }
  private async cliCredential(profile:CliAgentProfile){
    const key=await this.store.secret(cliSecretId(profile));
    if(!key)throw new HttpError(409,`请配置 ${profile.authentication==='claude-custom-api'?'第三方服务':profile.id==='claude-code'?'Anthropic':'Gemini'} API Key`);
    this.registerSecret(key);
    return key;
  }
  private async verifyCliCredential(profile:CliAgentProfile,key:string,signal:AbortSignal):Promise<CodexModelOption[]>{
    const claude=profile.id==='claude-code';
    const gateway=profile.authentication==='claude-custom-api'?profile.claudeGateway:undefined;
    const url=gateway?gateway.baseURL+'/v1/models':
      claude?'https://api.anthropic.com/v1/models?limit=256':'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1';
    const headers:HeadersInit=gateway?gatewayHeaders(gateway,key):
      claude?{'x-api-key':key,'anthropic-version':'2023-06-01'}:{'x-goog-api-key':key};
    const apiName=gateway?'第三方 API':'官方 API';
    const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}).catch(()=>{
      signal.throwIfAborted();throw new Error(`无法连接${apiName}，请检查地址与网络`);
    });
    if(!response.ok||!claude){
      await response.body?.cancel();
      if(!response.ok&&!(gateway&&[404,405,501].includes(response.status)))
        throw new Error([400,401,403].includes(response.status)?'API Key 未通过验证，请检查 Key、发送方式和账户权限':`${apiName} 返回 HTTP ${response.status}`);
      return [];
    }
    const result=(gateway?await readGatewayJson(response):await response.json().catch(()=>null)) as
      {data?:({id?:unknown;capabilities?:{effort?:ClaudeEffortMetadata}}|null)[]}|null|undefined;
    signal.throwIfAborted();
    if(!Array.isArray(result?.data)){
      if(gateway)return [];
      throw new Error('Anthropic 未返回可用模型目录');
    }
    const models=new Map<string,CodexModelOption>();
    for(const entry of result.data){
      const id=entry?.id;
      if(!isCliModelId(id)||(gateway?id.includes(key):!id.startsWith('claude-'))||models.has(id))continue;
      const effort=entry?.capabilities?.effort;
      const reasoningEfforts=effort?.supported===true?claudeEfforts.filter(level=>effort[level]?.supported===true):[];
      models.set(id,{id,reasoningEfforts});
      if(models.size>=256)break;
    }
    return [...models.values()];
  }
  private async verifyGatewayModel(gateway:ClaudeGateway,key:string,model:string,signal:AbortSignal){
    const headers={...gatewayHeaders(gateway,key),'content-type':'application/json'};
    const body=JSON.stringify({model,max_tokens:1,messages:[{role:'user',content:'Hi'}]});
    const response=await fetch(gateway.baseURL+'/v1/messages',{method:'POST',headers,body,redirect:'error',
      signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])}).catch(()=>{
      signal.throwIfAborted();throw new Error('无法连接第三方 API，请检查地址与网络');
    });
    if(!response.ok){
      await response.body?.cancel();
      throw new Error([401,403].includes(response.status)?'API Key 未通过验证，请检查 Key、发送方式和模型权限':
        `模型测试返回 HTTP ${response.status}，请检查模型 ID 和 Anthropic Messages 地址`);
    }
    const message=await readGatewayJson(response) as {type?:unknown;role?:unknown;content?:unknown}|undefined;
    signal.throwIfAborted();
    if(message?.type!=='message'||message.role!=='assistant'||!Array.isArray(message.content))
      throw new Error('第三方 API 未返回 Anthropic Messages 格式，请检查服务地址');
  }
  private async antigravityCatalog(environment:Omit<AgentLaunch,'args'>,signal:AbortSignal){
    const connection=await Antigravity.launch(environment,()=>{});
    try{
      const capabilities=await connection.initialize(signal);
      await connection.openSession({cwd:environment.cwd},signal);
      const models=await connection.discoverModels(signal),localModel=connection.localModel;
      if(!models.length)throw new Error('Google Antigravity 未返回可用模型');
      return {capabilities,model:localModel,localModel,models};
    }finally{await connection.close();}
  }
  private async googleCredentialFile(directory:string){
    // Current agy and earlier ACP builds use different names for the private token file.
    for(const name of ['antigravity-oauth-token','acp_token.json']){
      const file=join(directory,name),info=await lstat(file).catch(()=>undefined);
      if(!info?.isFile()||info.uid!==process.getuid?.())continue;
      if(info.mode&0o077)await chmod(file,0o600);
      return;
    }
    throw new HttpError(409,'Antigravity 未生成独立的 Google 登录凭据，请重新授权');
  }
  private async probeDirectory(projectId:string,agent:string){
    const parent=await privatePath(this.store.data,'external-agents','probe',projectId,agent);
    return mkdtemp(join(parent,'check-'));
  }
  private async probeCli(profile:CliAgentProfile,directory:string,signal:AbortSignal,testModel:boolean){
    const {projectId,id,authentication}=profile,name=externalAgentName(id);
    const probe:CodexConnectionProbe={revision:profile.revision,authentication:profile.authentication,ready:false,cliCatalogVersion};
    try{
      const inspected=await this.inspectCli(profile,directory,signal);
      probe.cliVersion=inspected.version;
      if(!inspected.supported)throw new Error(this.cliVersionMessage(profile,inspected.version));
      if(authentication==='claude-local'){
        probe.accountFingerprint=await claudeLocalAccount(inspected.environment,signal);
        const {models,localModel}=await discoverClaudeModels(inspected.environment,signal);
        Object.assign(probe,{authMode:'claude_login',model:profile.modelOverride??localModel,localModel,models});
      }else if(authentication==='antigravity-google'){
        if(!profile.googleLoginId)throw new HttpError(409,antigravityLoginRequired);
        await this.googleCredentialFile(await antigravityCredentials(this.store.home,projectId,profile.googleLoginId));
        Object.assign(probe,await this.antigravityCatalog(inspected.environment,signal),{authMode:'google'});
      }else{
        const key=await this.cliCredential(profile);
        const models=await this.verifyCliCredential(profile,key,signal);
        if(id==='claude-code'){
          probe.model=profile.modelOverride;
          probe.models=models;
          if(authentication==='claude-custom-api'&&profile.claudeGateway){
            if(testModel&&probe.model){
              await this.verifyGatewayModel(profile.claudeGateway,key,probe.model,signal);
              if(!models.length)probe.models=[{id:probe.model,reasoningEfforts:[]}];
            }else if(!models.length){
              throw new Error(probe.model?'服务商未提供模型列表，点击「检测连接」测试所填模型':'服务商未提供模型列表，请填写模型 ID 并保存');
            }
          }
        }else{
          inspected.environment.env.GEMINI_API_KEY=key;
          Object.assign(probe,await this.antigravityCatalog(inspected.environment,signal));
        }
        probe.authMode='api_key';
      }
      probe.ready=true;probe.authenticated=true;
      probe.message=authentication==='claude-local'?'已复用本机 Claude Code 登录':
        authentication==='claude-custom-api'?(testModel&&probe.model?'第三方模型检测通过':'已加载第三方模型列表'):`${name} 已连接`;
    }catch(error){probe.message=this.redact(error instanceof Error?error.message:`${name} 连接失败`);}
    signal.throwIfAborted();
    if(this.registry.get(projectId,id).revision!==profile.revision)throw new HttpError(409,'CLI 配置已变化，请重新检测连接');
    const key=projectId+':'+id,previous=this.registry.probe(projectId,id);
    this.store.transaction(()=>{
      if(previous?.revision===profile.revision&&previous.accountFingerprint){
        if(probe.accountFingerprint&&previous.accountFingerprint!==probe.accountFingerprint){
          probe.revision++;
          this.store.put('acpProfiles',key,{...profile,revision:probe.revision,updatedAt:now()});
        }
        probe.accountFingerprint??=previous.accountFingerprint;
      }
      this.store.put('acpProbes',key,{...probe,checkedAt:Date.now()});
    });
    if(!probe.ready)throw new HttpError(409,probe.message??`${name} 连接失败`);
    return {ok:true,capabilities:probe.capabilities};
  }
  async probe(projectId:string,agent:unknown,signal:AbortSignal,testModel=false){
    const profile=this.registry.get(projectId,agent);
    if(profile.id!=='codex'){
      const directory=await this.probeDirectory(projectId,profile.id);
      try{return await this.probeCli(profile,directory,signal,testModel);}
      finally{await rm(directory,{recursive:true,force:true});}
    }
    const directory=await privatePath(this.store.data,'external-agents','probe',projectId,profile.id);
    let transport:AgentConnection|undefined;
    try{
      const launch=await this.launch(profile,directory,signal,undefined,undefined,'probe');
      if(!launch.observed)throw new Error('未能确认本机 Codex 配置与登录状态');
      transport=new CodexAppServer(launch,()=>{});
      const capabilities=await transport.initialize(signal);
      if(this.registry.get(projectId,profile.id).revision!==profile.revision)throw new Error('本机 Codex 配置或账号已变化，请重新连接');
      const message=launch.observed.authenticated?'已连接本机 Codex，复用已有登录与配置':'本机 Codex 尚未登录，请先在 Codex 中完成登录后重新连接';
      this.store.put<CodexConnectionProbe>('acpProbes',projectId+':'+profile.id,{connectionVersion:codexConnectionVersion,revision:profile.revision,authentication:'codex-local',ready:true,
        ...launch.observed,localModel:launch.localModel,models:launch.models,capabilities,message});
      return {ok:true,capabilities};
    }catch(error){
      const message=this.redact(error instanceof Error?error.message:'Codex 连接失败');
      if(this.registry.get(projectId,profile.id).revision===profile.revision)
        this.store.put<CodexConnectionProbe>('acpProbes',projectId+':'+profile.id,{connectionVersion:codexConnectionVersion,revision:profile.revision,authentication:'codex-local',ready:false,message});
      throw new HttpError(409,message);
    }
    finally{await transport?.close();}
  }
  async status(projectId:string){
    const agents=await this.registry.list(projectId);
    await Promise.all(agents.map(async agent=>{
      const probe=this.registry.probe(projectId,agent.id);
      const current=probe?.revision===agent.revision&&probe.authentication===agent.authentication;
      const needsCliCatalog=agent.id!=='codex'&&probe?.ready===true&&(probe.cliCatalogVersion!==cliCatalogVersion||probe.models===undefined);
      const needsLocalStatus=agent.authentication==='claude-local'&&Date.now()-(probe?.checkedAt??0)>30000;
      if(!agent.enabled||!agent.installed||current&&!needsCliCatalog&&!needsLocalStatus)return;
      const key=projectId+':'+agent.id;
      const previous=this.probes.get(key);if(previous){await previous.work;return;}
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('读取本机执行器状态超时')),90000);
      const work=this.probe(projectId,agent.id,controller.signal).catch(()=>{}).finally(()=>{clearTimeout(timer);this.probes.delete(key);});
      this.probes.set(key,{controller,work});await work;
    }));
    return this.registry.list(projectId);
  }
  async prepare(projectId:string,agent:unknown,input:Record<string,unknown>,signal:AbortSignal){
    if(input.enabled===true&&process.platform!=='darwin')throw new HttpError(409,'当前平台尚未开放本机执行器');
    const profile=await this.registry.save(projectId,agent,input);signal.throwIfAborted();
    if(profile.enabled){
      if(profile.id==='codex'){
        if(!(await this.registry.list(projectId)).find(status=>status.id===profile.id)?.installed)
          await this.registry.install(projectId,profile.id,profile.npmPath,signal);
        signal.throwIfAborted();await this.probe(projectId,profile.id,signal);
      }else{
        // Connection failure is reported alongside the saved CLI preferences.
        await this.probe(projectId,profile.id,signal).catch(error=>{if(!(error instanceof HttpError)||error.status!==409)throw error;});
      }
    }
    return {agents:await this.registry.list(projectId)};
  }
  private finishGoogleLogin(login:GoogleLogin){
    return login.cleanup??=(async()=>{
      clearTimeout(login.timer);
      login.controller.abort(new HttpError(409,googleExpired));
      await login.cli?.close();
      await Promise.allSettled([login.started,login.verifying]);
      await Promise.allSettled([
        login.directory&&rm(login.directory,{recursive:true,force:true}),
        login.credentials&&!login.committed&&rm(login.credentials,{recursive:true,force:true}),
      ]);
      if(this.googleLogins.get(login.profile.projectId)===login)this.googleLogins.delete(login.profile.projectId);
    })();
  }
  async startGoogleLogin(projectId:string,expectedRevision:unknown,signal:AbortSignal){
    const profile=this.registry.get(projectId,'antigravity');
    if(profile.id!=='antigravity'||profile.authentication!=='antigravity-google'||profile.revision!==expectedRevision)
      throw new HttpError(409,'请保存 Google 登录方式后重新授权');
    if(this.googleLogins.has(projectId))throw new HttpError(409,'已有 Google 登录正在进行');
    const login:GoogleLogin={id:randomUUID(),profile,controller:new AbortController()};
    this.googleLogins.set(projectId,login);
    login.timer=setTimeout(()=>void this.finishGoogleLogin(login),5*60*1000);
    const startup=AbortSignal.any([signal,login.controller.signal,AbortSignal.timeout(45000)]);
    login.started=(async()=>{
      login.directory=await this.probeDirectory(projectId,profile.id);
      login.credentials=await antigravityCredentials(this.store.home,projectId,login.id);
      const inspected=await this.inspectCli(profile,login.directory,startup,login.id);
      if(!inspected.supported)throw new HttpError(409,this.cliVersionMessage(profile,inspected.version));
      startup.throwIfAborted();
      login.environment=inspected.environment;
      login.cliVersion=inspected.version;
      const cli=login.cli=launchAntigravityLogin(inspected.environment);
      const abort=()=>void cli.close();
      startup.addEventListener('abort',abort,{once:true});
      try{
        const authorizationUrl=await cli.authorization;
        startup.throwIfAborted();
        // If agy stops while waiting for the code, release the pending login.
        void cli.exited.then(()=>{if(!login.verifying)void this.finishGoogleLogin(login);});
        return login.authorization={id:login.id,authorizationUrl};
      }finally{startup.removeEventListener('abort',abort);}
    })();
    try{return await login.started;}
    catch(error){await this.finishGoogleLogin(login);throw error;}
  }
  async completeGoogleLogin(projectId:string,loginId:string,code:unknown,signal:AbortSignal){
    const login=this.googleLogins.get(projectId);
    if(!login||login.id!==loginId||!login.authorization||login.cleanup)throw new HttpError(409,googleExpired);
    if(login.verifying)throw new HttpError(409,'正在验证 Google 授权');
    const authorizationCode=antigravityAuthorizationCode(code,login.authorization.authorizationUrl);
    const verification=AbortSignal.any([signal,login.controller.signal,AbortSignal.timeout(90000)]);
    const cli=login.cli!,profile=login.profile;
    const assertRevision=()=>{
      verification.throwIfAborted();
      if(this.registry.get(projectId,'antigravity').revision!==profile.revision)
        throw new HttpError(409,'CLI 配置已变化，请重新登录 Google');
    };
    login.verifying=(async()=>{
      assertRevision();
      const abort=()=>void cli.close();
      verification.addEventListener('abort',abort,{once:true});
      try{
        cli.submit(authorizationCode);
        if(!await cli.exited)throw new HttpError(409,'Google 授权失败，请重新获取授权链接');
        assertRevision();
        await this.googleCredentialFile(login.credentials!);
        const catalog=await this.antigravityCatalog(login.environment!,verification);
        assertRevision();
        const key=projectId+':antigravity',revision=profile.revision+1;
        this.store.transaction(()=>{
          this.store.put('acpProfiles',key,{...profile,googleLoginId:login.id,revision,updatedAt:now()});
          this.store.put<CodexConnectionProbe>('acpProbes',key,{...catalog,authentication:profile.authentication,cliCatalogVersion,
            ready:true,authenticated:true,authMode:'google',revision,cliVersion:login.cliVersion,checkedAt:Date.now(),
            message:'Google 登录已就绪，已加载可用模型'});
        });
        login.committed=true;
      }finally{verification.removeEventListener('abort',abort);}
    })();
    try{await login.verifying;return {agents:await this.registry.list(projectId)};}
    catch(error){
      if(error instanceof HttpError)throw error;
      throw new HttpError(409,this.redact(error instanceof Error?error.message:'Google 登录验证失败'));
    }
    finally{await this.finishGoogleLogin(login);}
  }
  async cancelGoogleLogin(projectId:string,loginId:string){
    const login=this.googleLogins.get(projectId);
    if(login?.id===loginId)await this.finishGoogleLogin(login);
    return {ok:true};
  }
  private async connectCli(profile:CliAgentProfile,directory:string,signal:AbortSignal,publish:(event:AgentActivity)=>void,mcp:ScopedStdioMcp|ScopedHttpMcp|undefined,model:string|undefined,systemPrompt:string|undefined,observeModel:ObserveAgentModel){
    const selected=model??profile.modelOverride;
    if(selected!==undefined&&!isCliModelId(selected))throw new HttpError(400,'模型 ID 无效');
    const probe=this.registry.probe(profile.projectId,profile.id);
    const selectedDefault=profile.modelOverride??probe?.localModel??probe?.model;
    const effort=profile.reasoningEffortOverride;
    const supportedEffort=effort&&probe?.revision===profile.revision&&
      probe.models?.find(option=>option.id===(selected??selectedDefault))?.reasoningEfforts.includes(effort)?effort:undefined;
    if(effort&&!supportedEffort&&(!selected||selected===selectedDefault))
      throw new HttpError(409,'所选模型的思考强度已变化，请重新检测连接并选择');
    const inspected=await this.inspectCli(profile,directory,signal);
    if(!inspected.supported)throw new HttpError(409,this.cliVersionMessage(profile,inspected.version));
    if(profile.id==='claude-code'){
      if(profile.authentication==='claude-local'){
        const account=await claudeLocalAccount(inspected.environment,signal);
        if(probe?.revision!==profile.revision||probe.accountFingerprint!==account)
          throw new HttpError(409,'本机 Claude Code 登录已变化，请重新检测连接');
      }else{
        const key=await this.cliCredential(profile);
        const env=inspected.environment.env;
        if(profile.authentication==='claude-custom-api'){
          if(!profile.claudeGateway||!selected)throw new HttpError(409,'请为自定义 API 选择模型并保存');
          env.ANTHROPIC_BASE_URL=profile.claudeGateway.baseURL;
          if(profile.claudeGateway.credentialHeader==='authorization'){
            env.ANTHROPIC_API_KEY='';
            env.ANTHROPIC_AUTH_TOKEN=key;
          }else env.ANTHROPIC_API_KEY=key;
        }else env.ANTHROPIC_API_KEY=key;
      }
      return new ClaudeCode(inspected.environment,publish,mcp&&'command' in mcp?mcp:undefined,selected,observeModel,supportedEffort);
    }
    if(profile.authentication==='antigravity-google'){
      if(!profile.googleLoginId)throw new HttpError(409,antigravityLoginRequired);
      await this.googleCredentialFile(await antigravityCredentials(this.store.home,profile.projectId,profile.googleLoginId));
    }else inspected.environment.env.GEMINI_API_KEY=await this.cliCredential(profile);
    return Antigravity.launch(inspected.environment,publish,mcp&&'serverUrl' in mcp?mcp:undefined,selected,systemPrompt,observeModel,supportedEffort);
  }
  private result(run:ExternalRun):ExternalResult{const last=run.events.findLast(event=>event.kind==='text'&&event.publicTextId&&typeof event.publicText==='string');return {run_id:run.id,agent:externalAgentName(run.agent),state:run.state,summary:run.summary??run.error??'',
    ...(run.stopReason==='deadline_reached'&&{stop_reason:'deadline_reached' as const}),
    ...(last&&{public_reply:{id:last.publicTextId!,content:last.publicText!}}),verification:'insufficient',
    limitations:['外部运行返回本次报告；请结合实际工具结果汇总原任务结论，如实说明失败或未知结果。']};}
  async run(agent:unknown,instruction:string,requestKey:string,actor:ExternalActor,resumeRunId?:string):Promise<ExternalResult>{
    const agentId=externalAgentId(agent);actor.guard();actor.signal.throwIfAborted();
    if(actor.purpose==='conversation'){
      if(!actor.conversationId||actor.taskId||actor.tools.length||resumeRunId)throw new HttpError(409,'对话执行必须使用独立来源且不携带业务工具或重放上下文');
    }else if(!actor.taskId||actor.conversationId)throw new HttpError(409,'业务外部执行缺少原任务身份');
    if(!instruction.trim()||Buffer.byteLength(instruction)>65536)throw new HttpError(400,'外部任务说明需要 1–65536 字节');
    const profile=this.registry.get(actor.projectId,agentId);if(!profile.enabled)throw new HttpError(409,'请先启用该项目的外部 Agent');
    const inputHash=digest({agent:agentId,instruction,resumeRunId:resumeRunId??null,...(actor.model?{model:actor.model}:{})});
    const duplicate=this.store.list<ExternalRun>('acpRuns').find(run=>run.requestKey===requestKey);
    if(duplicate){if(duplicate.schemaVersion!==1||duplicate.inputHash!==inputHash||duplicate.agent!==agentId||duplicate.profileRevision!==profile.revision||duplicate.scopeHash!==actor.scopeHash||duplicate.projectId!==actor.projectId||duplicate.taskId!==actor.taskId||duplicate.conversationId!==actor.conversationId||(duplicate.purpose??'segment')!==(actor.purpose??'segment')||duplicate.workerId!==actor.workerId||duplicate.generation!==actor.generation||duplicate.sessionId!==actor.sessionId||duplicate.childSessionId!==actor.childSessionId)throw new HttpError(409,'原外部调用的身份或输入不匹配');return this.result(duplicate);}
    const prior=resumeRunId?this.store.require<ExternalRun>('acpRuns',resumeRunId):undefined;
    if(prior&&(prior.schemaVersion!==1||prior.projectId!==actor.projectId||prior.taskId!==actor.taskId||prior.workerId!==actor.workerId||prior.generation!==actor.generation||prior.scopeHash!==actor.scopeHash||prior.sessionId!==actor.sessionId||prior.childSessionId!==actor.childSessionId||prior.agent!==agentId||prior.requestedModel!==actor.model||prior.profileRevision!==profile.revision||prior.dispatchPhase!=='answered'||prior.state!=='completed'||!prior.contextId||!prior.externalSessionId))throw new HttpError(409,'只能继续同一执行身份与模型下已明确结束的外部会话');
    if(prior&&[...this.live.keys()].some(key=>this.store.get<ExternalRun>('acpRuns',key)?.contextId===prior.contextId))throw new HttpError(409,'该外部会话仍在运行');
    const conversation=actor.purpose==='conversation';
    const active=[...this.live.values()].filter(run=>run.conversation===conversation).length;
    if(active>=(conversation?maxExternalConversationRuns:4))throw new HttpError(409,'外部 Agent 正在处理其他工作，请稍后继续原任务');
    const runId=id();
    const run:ExternalRun={schemaVersion:1,id:runId,purpose:actor.purpose??'segment',contextId:prior?.contextId??runId,scopeHash:actor.scopeHash,agent:agentId,profileRevision:profile.revision,projectId:actor.projectId,taskId:actor.taskId,conversationId:actor.conversationId,workerId:actor.workerId,sessionId:actor.sessionId,
      childSessionId:actor.childSessionId,agentRunId:actor.agentRunId,rootTurnId:actor.rootTurnId,generation:actor.generation,requestKey,inputHash,...(actor.model?{requestedModel:actor.model}:{}),state:'starting',dispatchPhase:'not_sent',createdAt:now(),updatedAt:now(),events:[],usage:null};
    const controller=new AbortController(),stop=()=>controller.abort(actor.signal.reason);
    actor.signal.addEventListener('abort',stop,{once:true});
    const live:LiveRun={controller,scopeHash:actor.scopeHash,conversation};this.live.set(run.id,live);
    const stopDeadline=watchTaskDeadline(()=>actor.deadlineAt,controller);
    const guard=()=>{controller.signal.throwIfAborted();actor.guard();if(Date.parse(actor.deadlineAt)<=Date.now())throw new TaskDeadlineReached();
      const current=this.registry.get(actor.projectId,agentId);if(!current.enabled||current.revision!==profile.revision)throw new HttpError(409,'外部 Agent 配置已变化');};
    live.guard=guard;
    const fence=setInterval(()=>{try{guard();}catch(error){controller.abort(error);}},1000);
    let bridge:Awaited<ReturnType<typeof openToolBridge>>|undefined,httpBridge:Awaited<ReturnType<typeof openHttpToolBridge>>|undefined;
    let submittedReport='',eventBytes=0;
    const text=new ExternalPublicText(run.id,this.redact);
    const persist=()=>{run.updatedAt=now();this.store.put('acpRuns',run.id,run);};
    const event=(value:Omit<ExternalEvent,'sequence'|'at'>)=>{
      const clean=Object.fromEntries(Object.entries(value).map(([key,item])=>{
        if(typeof item!=='string'||!['text','publicText','title','callId','detail','preview'].includes(key))return [key,item];
        const prose=key==='text'||key==='publicText';
        const limit=prose?32768:key==='detail'&&value.displayKind==='command'?commandLimit:512;
        return [key,this.redact(item,prose).slice(0,limit)];
      }));
      const entry:ExternalEvent={...value,...clean,sequence:run.events.length+1,at:now()};eventBytes+=Buffer.byteLength(JSON.stringify(entry));
      if(eventBytes<=16*1024*1024&&run.events.length<2048)run.events.push(entry);
      else if(!controller.signal.aborted)controller.abort(new Error('外部 Agent 过程输出达到本次上限'));
      persist();actor.event(run,entry);
    };
    const tools=actor.tools.filter(tool=>(!externalControlTools.has(tool.metadata.name)||actor.purpose==='worker'&&['Agent','Task','TaskOutput','TaskStop','SendMessage'].includes(tool.metadata.name))&&
      (actor.purpose==='worker'||!['work_begin','work_update','work_finish','work_wait','ask_user_question','recall_memory','recall_task_context'].includes(tool.metadata.name)));
    const activePrompt=()=>{guard();if(run.state!=='running'||!['dispatching','sent'].includes(run.dispatchPhase))throw new HttpError(409,'当前没有可执行工具的外部 prompt');};
    const bridgeActivity=agentId!=='codex'&&run.purpose==='worker'&&!!run.rootTurnId&&!run.childSessionId&&!run.agentRunId;
    const invoke=async(name:string,input:unknown,callId:string)=>{
      activePrompt();
      if(!tools.some(tool=>tool.metadata.name===name))throw new HttpError(403,'外部执行不能调用此工具');
      const detail=bridgeActivity?codexToolDetail({type:'mcpToolCall',server:'lake',tool:name,arguments:input},this.redact):undefined;
      const recorded=bridgeActivity&&(detail||name==='work_finish');
      const tool={callId,title:name,toolSource:'lake-bridge' as const,...detail};
      if(recorded)event({kind:'tool',status:'running',...tool});
      let status='failed';
      let preview:string|undefined;
      try{
        const result=await actor.executeTool(name,input,run.id+':'+callId,controller.signal);
        guard();
        status='completed';
        if(actor.purpose==='worker'&&name==='work_finish'&&typeof (input as any)?.summary==='string')
          submittedReport=this.redact((input as any).summary).slice(0,32768);
        if(detail?.displayKind==='command'&&!detail.suppressOutput){
          const stdout=(result as {stdout?:string|{text?:unknown}}|undefined)?.stdout;
          const text=typeof stdout==='string'?stdout:stdout?.text;
          if(typeof text==='string')preview=outputLine(this.redact(text));
        }
        return result;
      }finally{
        if(recorded&&!controller.signal.aborted&&run.state==='running')
          event({kind:'tool_update',status,...tool,...(preview&&{preview})});
      }
    };
    persist();
    try{
      guard();
      const directory=await privatePath(this.store.data,'external-agents','runs',run.contextId);
      const toolDefinitions=tools.map(tool=>({name:tool.metadata.name,description:tool.metadata.description??tool.metadata.name,inputSchema:tool.inputSchema as Record<string,unknown>}));
      if(tools.length&&actor.purpose!=='conversation'){
        if(agentId==='antigravity'){
          httpBridge=await openHttpToolBridge(toolDefinitions,invoke);
          this.registerSecret(httpBridge.headers.Authorization.slice('Bearer '.length));
        }else bridge=await openToolBridge(toolDefinitions,invoke);
      }
      const launcher=ownLauncher('--internal-acp-mcp');
      const mcp=bridge?{command:'/usr/bin/env',args:['-i','PATH='+process.env.PATH,'HOME='+directory,'TMPDIR='+directory,'LANG='+(process.env.LANG??'en_US.UTF-8'),'LAKE_TS_IMPORT_ONLY=0',launcher.executable,...launcher.args,bridge.socket]}:undefined;
      const publish=(update:AgentActivity)=>{
        if(controller.signal.aborted||!['dispatching','sent'].includes(run.dispatchPhase))return;
        if(update.kind==='input'){guard();actor.inputConsumed?.(update.inputId);}
        else if(update.kind==='usage'){run.usage=update.usage;persist();}
        else if((update.kind==='tool_update'||update.kind==='tool')&&bridgeActivity&&update.scopedTool)return;
        else if((update.kind==='tool_update'||update.kind==='tool')&&update.transient){
          if(actor.purpose==='worker'&&update.preview)actor.event(run,{kind:'tool_update',status:update.status,callId:this.redact(update.callId),
            displayKind:update.displayKind,detail:this.redact(update.detail??'').slice(0,update.displayKind==='command'?commandLimit:512),preview:this.redact(update.preview,true).slice(0,200),sequence:run.events.length,at:now()});
        }
        else if(update.kind==='text')event({kind:'text',...(profile.id==='codex'?text.snapshot(update.text,update.messageId,update.messageText):text.replace(update.messageId,update.messageText))});
        else if(actor.purpose==='worker'&&!actor.childSessionId&&!actor.agentRunId)event(update);
        else event({kind:update.kind,callId:update.callId,title:update.title,status:update.status});
      };
      const model=actor.model??prior?.model;
      let transport:AgentConnection;
      if(profile.id==='codex'){
        const launch=await this.launch(profile,directory,controller.signal,mcp,model);
        if(launch.observed){run.model=launch.observed.model;run.modelProvider=launch.observed.modelProvider;run.reasoningEffort=launch.observed.reasoningEffort;persist();}
        transport=new CodexAppServer(launch,publish,bridge?{server:'lake',tools:new Set(toolDefinitions.map(tool=>tool.name)),guard:activePrompt}:undefined,this.redact);
      }else{
        const endpoint=httpBridge?{serverUrl:httpBridge.serverUrl,headers:httpBridge.headers}:mcp;
        transport=await this.connectCli(profile,directory,controller.signal,publish,endpoint&&{...endpoint,tools:toolDefinitions,guard:activePrompt},model,actor.systemPrompt,(reported,provider,effort)=>{
          run.model=reported;run.modelProvider=provider;run.reasoningEffort=effort;persist();
        });
      }
      live.process=transport;
      const cancel=()=>{void transport.cancel().finally(()=>transport.close()).catch(()=>{});};controller.signal.addEventListener('abort',cancel,{once:true});
      await transport.initialize(controller.signal);
      run.runtimeKind=profile.runtimeKind;
      run.externalSessionId=await transport.openSession({cwd:directory,threadId:prior?.externalSessionId,systemPrompt:actor.systemPrompt},controller.signal);
      guard();run.state='running';run.dispatchPhase='dispatching';persist();event({kind:'status',status:'running'});
      const prompt=transport.exec(instruction,controller.signal);
      run.dispatchPhase='sent';persist();
      const response=await prompt;guard();run.dispatchPhase='answered';run.stopReason=response.stopReason;
      if(response.error)run.error=this.redact(response.error);
      run.summary=this.redact(text.auditText||submittedReport).slice(0,32768);run.state=response.stopReason==='end_turn'?'completed':response.stopReason==='cancelled'?'cancelled':'failed';
      if(!run.summary&&run.state==='completed'){run.state='failed';run.error='外部 Agent 没有返回业务报告';}
      persist();event({kind:'status',status:run.state});
      return this.result(run);
    }catch(error){
      if(error instanceof TaskDeadlineReached||controller.signal.reason instanceof TaskDeadlineReached)run.stopReason='deadline_reached';
      run.error=this.redact((error instanceof Error?error.message:'外部 Agent 执行失败')+((error as any)?.data?': '+JSON.stringify((error as any).data).slice(0,4096):'')+(live.process?.diagnostics()?': '+live.process.diagnostics().slice(-4096):''));
      run.summary=this.redact(text.auditText).slice(0,32768);
      run.state=run.dispatchPhase==='not_sent'?(controller.signal.aborted||run.stopReason==='deadline_reached'?'cancelled':'failed'):'unknown';persist();event({kind:'status',status:run.state});
      if(run.state==='failed'&&!run.summary)throw new HttpError(409,run.error);return this.result(run);
    }finally{
      this.indexClosingMessages(run);stopDeadline();clearInterval(fence);controller.abort(new Error('外部执行已结束'));
      actor.signal.removeEventListener('abort',stop);
      await Promise.allSettled([bridge?.close(),httpBridge?.close(),live.process?.close()]);
      this.live.delete(run.id);
    }
  }
  active(sessionId:string){return [...this.live.keys()].some(id=>this.store.get<ExternalRun>('acpRuns',id)?.sessionId===sessionId);}
  async steer(sessionId:string,input:string,inputId:string,agentRunId?:string){
    if(!input.trim()||Buffer.byteLength(input)>65536)return {kind:'rejected'};
    const matches=[...this.live].filter(([id])=>{
      const run=this.store.get<ExternalRun>('acpRuns',id);
      return run?.sessionId===sessionId&&run.state==='running'&&run.dispatchPhase==='sent'&&
        (agentRunId?run.agentRunId===agentRunId:run.purpose==='worker'&&!run.childSessionId);
    });
    if(matches.length!==1)return {kind:'rejected'};
    const [,live]=matches[0];live.guard?.();
    return {kind:await live.process?.steer(input,inputId,live.controller.signal)?'queued':'rejected'};
  }
  async close(){
    for(const probe of this.probes.values())probe.controller.abort();
    await Promise.allSettled([...this.googleLogins.values()].map(login=>this.finishGoogleLogin(login)));
    await Promise.allSettled([...this.probes.values()].map(probe=>probe.work));
    await Promise.allSettled([...this.live.values()].map(async live=>{live.controller.abort();await live.process?.close();}));
  }
}
