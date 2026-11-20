import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSea } from 'node:sea';
import { LakeStore,HttpError,id,now } from '../store';
import { digest } from '../tasks';
import {TaskDeadlineReached,watchTaskDeadline} from '../task-deadline';
import type {AgentConnection,AgentLaunch} from './client';
import {CodexAppServer} from './codex-app-server';
import { ExternalAgentRegistry } from './registry';
import { externalAgentId,externalControlTools,externalProducts } from './catalog';
import {externalAgentName} from '../../../web-agent/shared/external-agents';
import { openToolBridge } from './bridge';
import {privatePath} from './private';
import {codexConfig,tomlValue} from './codex-profile';
import {ExternalPublicText} from './public-text';
import type { CodexConnectionProbe,ExternalActor,ExternalAgentProfile,ExternalEvent,ExternalResult,ExternalRun } from './types';
import {maxExternalConversationRuns} from './types';

function ownLauncher(flag:string,args:string[]=[]){return {executable:process.execPath,args:isSea()?[flag,...args]:[__filename,flag,...args]};}
type LiveRun={process?:AgentConnection;controller:AbortController;scopeHash:string;conversation:boolean;guard?:()=>void};
export class LakeExternalAgents {
  readonly registry:ExternalAgentRegistry;
  private probes=new Map<string,{controller:AbortController;work:Promise<unknown>}>();
  private live=new Map<string,LiveRun>();
  constructor(readonly store:LakeStore,readonly redact:(text:string,live?:boolean)=>string,readonly registerSecret:(value:string)=>void,codexHome?:string){
    this.registry=new ExternalAgentRegistry(store,{codexHome,registerSecret});
    for(const run of store.list<ExternalRun>('acpRuns'))if(run.schemaVersion===1&&['starting','running'].includes(run.state)){
      run.state=run.dispatchPhase==='not_sent'?'interrupted':'unknown';run.updatedAt=now();store.put('acpRuns',run.id,run);
    }
  }
  private async launch(profile:ExternalAgentProfile,directory:string,signal:AbortSignal,mcp?:{command:string;args:string[]},model?:string,purpose:'run'|'probe'='run'):Promise<AgentLaunch>{
    if(process.platform!=='darwin')throw new HttpError(409,'当前平台的 Codex 工具隔离尚未验证');
    if(!profile.nodePath)throw new HttpError(409,'请先配置 Codex 使用的 Node 运行时');
    const engine=JSON.parse(await readFile(join(this.registry.runtimeRoot(),'node_modules/@openai/codex/package.json'),'utf8'));
    if(engine.version!==externalProducts.codex.version)throw new HttpError(409,'Codex 引擎版本不匹配，请重新安装固定版本');
    await this.registry.validateNode(profile.nodePath);
    const prepared=purpose==='probe'
      ? await this.registry.prepareConnection(profile,signal)
      : await this.registry.prepareLaunch(profile,signal,model);
    const threadConfig={...codexConfig(prepared.home),...(purpose==='run'?{model:prepared.observed.model}:{}),mcp_servers:{...prepared.disabledMcp,...(mcp?{lake:mcp}:{})}};
    return {executable:prepared.command,args:[...prepared.args.slice(0,-1),'-c','mcp_servers='+tomlValue(threadConfig.mcp_servers),'app-server'],
      cwd:directory,observed:prepared.observed,threadConfig,env:{...prepared.environment,TMPDIR:directory}};
  }
  async probe(projectId:string,agent:unknown,signal:AbortSignal){
    const profile=this.registry.get(projectId,agent),directory=await privatePath(this.store.data,'external-agents','probe',projectId,profile.id);
    let transport:AgentConnection|undefined;
    try{
      const launch=await this.launch(profile,directory,signal,undefined,undefined,'probe');
      if(!launch.observed)throw new Error('未能确认本机 Codex 配置与登录状态');
      transport=new CodexAppServer(launch,()=>{});
      const capabilities=await transport.initialize(signal);
      if(this.registry.get(projectId,profile.id).revision!==profile.revision)throw new Error('本机 Codex 配置或账号已变化，请重新连接');
      const message=launch.observed.authenticated?'已连接本机 Codex，复用已有登录与配置':'本机 Codex 尚未登录，请先在 Codex 中完成登录后重新连接';
      this.store.put<CodexConnectionProbe>('acpProbes',projectId+':'+profile.id,{connectionVersion:1,revision:profile.revision,authentication:'codex-local',ready:true,...launch.observed,capabilities,message});
      return {ok:true,capabilities};
    }catch(error){
      const message=this.redact(error instanceof Error?error.message:'Codex 连接失败');
      if(this.registry.get(projectId,profile.id).revision===profile.revision)
        this.store.put<CodexConnectionProbe>('acpProbes',projectId+':'+profile.id,{connectionVersion:1,revision:profile.revision,authentication:'codex-local',ready:false,message});
      throw new HttpError(409,message);
    }
    finally{await transport?.close();}
  }
  async status(projectId:string){
    const agents=await this.registry.list(projectId);
    await Promise.all(agents.map(async agent=>{
      const probe=this.registry.probe(projectId,agent.id);
      if(!agent.enabled||!agent.installed||probe?.revision===agent.revision&&probe.authentication==='codex-local')return;
      const key=projectId+':'+agent.id;
      const previous=this.probes.get(key);if(previous){await previous.work;return;}
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('读取本机 Codex 配置超时')),90000);
      const work=this.probe(projectId,agent.id,controller.signal).catch(()=>{}).finally(()=>{clearTimeout(timer);this.probes.delete(key);});
      this.probes.set(key,{controller,work});await work;
    }));
    return this.registry.list(projectId);
  }
  async prepare(projectId:string,agent:unknown,input:Record<string,unknown>,signal:AbortSignal){
    if(input.enabled===true&&process.platform!=='darwin')throw new HttpError(409,'当前平台的 Codex 执行尚未开放');
    const profile=await this.registry.save(projectId,agent,input);signal.throwIfAborted();
    if(profile.enabled){
      if(!(await this.registry.list(projectId))[0]?.installed)await this.registry.install(projectId,profile.id,profile.npmPath,signal);
      signal.throwIfAborted();await this.probe(projectId,profile.id,signal);
    }
    return {agents:await this.registry.list(projectId)};
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
    let bridge:Awaited<ReturnType<typeof openToolBridge>>|undefined,submittedReport='',eventBytes=0;
    const text=new ExternalPublicText(run.id,this.redact);
    const persist=()=>{run.updatedAt=now();this.store.put('acpRuns',run.id,run);};
    const event=(value:Omit<ExternalEvent,'sequence'|'at'>)=>{
      const clean=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,['text','publicText','title','callId'].includes(key)&&typeof item==='string'?this.redact(item,key==='text'||key==='publicText').slice(0,key==='text'||key==='publicText'?32768:512):item]));
      const entry:ExternalEvent={...value,...clean,sequence:run.events.length+1,at:now()};eventBytes+=Buffer.byteLength(JSON.stringify(entry));
      if(eventBytes<=16*1024*1024&&run.events.length<2048)run.events.push(entry);
      else if(!controller.signal.aborted)controller.abort(new Error('外部 Agent 过程输出达到本次上限'));
      persist();actor.event(run,entry);
    };
    const tools=actor.tools.filter(tool=>(!externalControlTools.has(tool.metadata.name)||actor.purpose==='worker'&&['Agent','Task','TaskOutput','TaskStop','SendMessage'].includes(tool.metadata.name))&&
      (actor.purpose==='worker'||!['work_begin','work_update','work_finish','work_wait','ask_user_question','recall_memory','recall_task_context'].includes(tool.metadata.name)));
    const activePrompt=()=>{guard();if(run.state!=='running'||!['dispatching','sent'].includes(run.dispatchPhase))throw new HttpError(409,'当前没有可执行工具的外部 prompt');};
    const invoke=async(name:string,input:unknown,callId:string)=>{activePrompt();if(!tools.some(tool=>tool.metadata.name===name))throw new HttpError(403,'外部执行不能调用此工具');
      const result=await actor.executeTool(name,input,run.id+':'+callId,controller.signal);guard();
      if(actor.purpose==='worker'&&name==='work_finish'&&typeof (input as any)?.summary==='string')submittedReport=this.redact((input as any).summary).slice(0,32768);
      return result;};
    persist();
    try{
      guard();
      const directory=await privatePath(this.store.data,'external-agents','runs',run.contextId);
      if(agentId==='codex'&&actor.purpose!=='conversation')bridge=await openToolBridge(tools.map(tool=>({name:tool.metadata.name,description:tool.metadata.description??tool.metadata.name,inputSchema:tool.inputSchema as Record<string,unknown>})),invoke);
      const launcher=ownLauncher('--internal-acp-mcp');
      const mcp=bridge?{command:'/usr/bin/env',args:['-i','PATH='+process.env.PATH,'HOME='+directory,'TMPDIR='+directory,'LANG='+(process.env.LANG??'en_US.UTF-8'),'LAKE_TS_IMPORT_ONLY=0',launcher.executable,...launcher.args,bridge.socket]}:undefined;
      const launch=await this.launch(profile,directory,controller.signal,mcp,actor.model??prior?.model);
      if(launch.observed){run.model=launch.observed.model;run.modelProvider=launch.observed.modelProvider;run.reasoningEffort=launch.observed.reasoningEffort;persist();}
      const transport:AgentConnection=new CodexAppServer(launch,update=>{
        if(controller.signal.aborted||!['dispatching','sent'].includes(run.dispatchPhase))return;
        if(update.kind==='input'){guard();actor.inputConsumed?.(update.inputId);}
        else if(update.kind==='usage'){run.usage=update.usage;persist();}
        else if(update.kind==='text')event({kind:'text',...text.snapshot(update.text,update.messageId,update.messageText)});
        else event(update);
      },bridge?{server:'lake',tools:new Set(tools.map(tool=>tool.metadata.name)),guard:activePrompt}:undefined);
      live.process=transport;
      const cancel=()=>{void transport.cancel().finally(()=>transport.close());};controller.signal.addEventListener('abort',cancel,{once:true});
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
    }finally{stopDeadline();clearInterval(fence);controller.abort(new Error('外部执行已结束'));actor.signal.removeEventListener('abort',stop);await bridge?.close();await live.process?.close();this.live.delete(run.id);}
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
  async close(){for(const probe of this.probes.values())probe.controller.abort();await Promise.allSettled([...this.probes.values()].map(probe=>probe.work));await Promise.allSettled([...this.live.values()].map(async live=>{live.controller.abort();await live.process?.close();}));}
}
