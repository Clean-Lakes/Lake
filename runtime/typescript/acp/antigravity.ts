import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import type {AgentActivity,AgentConnection,AgentLaunch,AgentTurnResult,ObserveAgentModel,ScopedHttpMcp} from './client';
import {isCliModelId} from './cli-profile';
import {JsonRpcProcess} from './process';
import {privateFile,privatePath} from './private';
import {digest} from '../tasks';

const loginRequired='Google Antigravity 未接受 Gemini API Key，请检测连接';
type ModelConfig={id:string;currentValue:string;options:unknown[]};
function modelConfig(result:any):ModelConfig|undefined {
  return Array.isArray(result?.configOptions)?result.configOptions.find((item:any)=>item?.type==='select'&&item.category==='model'&&
    typeof item.id==='string'&&isCliModelId(item.currentValue)&&Array.isArray(item.options)):undefined;
}
function modelOptions(config:ModelConfig|undefined,legacy:any):string[]{
  const options=config?.options??[];
  const values=options.flatMap((option:any)=>Array.isArray(option?.options)?option.options.map((item:any)=>item?.value):[option?.value]);
  if(!config&&Array.isArray(legacy?.availableModels))values.push(...legacy.availableModels.map((item:any)=>item?.modelId));
  return [...new Set(values.filter(isCliModelId))].slice(0,256);
}

/** Google Antigravity's official ACP v1 endpoint. Native action requests are declined. */
export class Antigravity implements AgentConnection {
  private readonly rpc:JsonRpcProcess;
  private sessionId?:string;
  private resume=false;
  private turn?:{messages:Map<string,string>;calls:Map<string,string|false>};
  localModel?:string;
  model?:string;
  models:string[]=[];

  static async launch(launch:Omit<AgentLaunch,'args'>,publish:(event:AgentActivity)=>void,mcp?:ScopedHttpMcp,
    model?:string,systemPrompt?:string,observeModel?:ObserveAgentModel){
    const config=await privatePath(launch.env.HOME!,'.gemini','config');
    const agents=await privatePath(config,'agents');
    const servers=mcp?{lake:{serverUrl:mcp.serverUrl,headers:mcp.headers}}:{};
    // The restricted primary agent excludes the native shell, filesystem,
    // browser, scheduling and subagent tools. It sees this run's MCP only.
    const manifest=mcp?`Use call_mcp_tool with ServerName "lake", the exact ToolName, and Arguments from the following tool schemas. Use these Lake tools for any task progress, approvals and actions.\n${JSON.stringify(mcp.tools)}`:'';
    const instructions=['---','name: lake','description: Lake specialist execution','mainAgent: true','subagent: false',
      'tools: []','commandExecutionPolicy: off',`inheritMcp: ${!!mcp}`,'inheritCustomizations: false','---',systemPrompt??'',manifest].join('\n');
    await privateFile(agents,'lake.md',instructions);
    await privateFile(config,'mcp_config.json',JSON.stringify({mcpServers:servers}));
    return new Antigravity(launch,publish,join(config,'mcp_config.json'),mcp,model,observeModel);
  }

  private constructor(launch:Omit<AgentLaunch,'args'>,private readonly publish:(event:AgentActivity)=>void,
    private readonly configFile:string,private readonly mcp?:ScopedHttpMcp,private readonly requestedModel?:string,private readonly observeModel?:ObserveAgentModel){
    this.rpc=new JsonRpcProcess({...launch,args:['acp','--disable-telemetry','--agent','lake',...(mcp?['--process-per-session']:[])]},{
      request:async(method,params)=>{
        if(method!=='session/request_permission')throw new Error('该 ACP 请求未获得 Lake 授权');
        return this.permission(params);
      },
      notification:(method,params)=>this.update(method,params),
    },true);
  }
  private scopedCall(event:any){
    const input=event?.rawInput;
    return event?.name==='call_mcp_tool'&&typeof event.toolCallId==='string'&&event.toolCallId.length<=256&&input?.ServerName==='lake'&&
      this.mcp?.tools.some(tool=>tool.name===input.ToolName)===true;
  }
  private permission(params:any){
    const cancelled={outcome:{outcome:'cancelled'}};
    const turn=this.turn;
    if(!turn||params?.sessionId!==this.sessionId||!Array.isArray(params.options))return cancelled;
    const call=params.toolCall;
    const allowed=this.scopedCall(call)&&turn.calls.get(call.toolCallId)===digest(call.rawInput);
    const option=params.options.find((option:any)=>option?.kind===(allowed?'allow_once':'reject_once')&&typeof option.optionId==='string');
    if(!option)return cancelled;
    if(allowed){
      turn.calls.set(call.toolCallId,false);
      this.mcp!.guard();
    }
    return {outcome:{outcome:'selected',optionId:option.optionId}};
  }
  private async request(method:string,params:unknown,signal:AbortSignal){
    try{return await this.rpc.request(method,params,signal,method==='session/prompt'?2_147_483_647:20000);}
    catch(error){
      signal.throwIfAborted();
      if(error instanceof Error&&/authentication required/i.test(error.message))throw new Error(loginRequired);
      throw new Error(`Google Antigravity 的 ${method} 请求未完成`);
    }
  }
  async initialize(signal:AbortSignal){
    const result=await this.request('initialize',{protocolVersion:1,clientCapabilities:{},clientInfo:{name:'lake',title:'Lake',version:'1'}},signal);
    if(result?.protocolVersion!==1)throw new Error('Google Antigravity 的 ACP 协议版本不受支持');
    const capabilities=result.agentCapabilities?.sessionCapabilities;
    this.resume=!!capabilities?.resume;
    return {streaming:true,resume:this.resume,cancel:true};
  }
  async openSession(options:{cwd:string;threadId?:string},signal:AbortSignal){
    if(this.sessionId||options.threadId&&!this.resume)throw new Error('当前 Google Antigravity 连接无法继续原会话');
    const result=await this.request(options.threadId?'session/resume':'session/new',{
      cwd:options.cwd,mcpServers:[],...(options.threadId?{sessionId:options.threadId}:{}),
    },signal);
    const id=result?.sessionId??options.threadId;
    if(typeof id!=='string'||!id||id.length>256||options.threadId&&id!==options.threadId)throw new Error('Google Antigravity 没有返回对应会话');
    this.sessionId=id;
    const config=modelConfig(result),legacy=result?.models;
    this.localModel=config?.currentValue??(isCliModelId(legacy?.currentModelId)?legacy.currentModelId:undefined);
    this.models=modelOptions(config,legacy);
    this.model=this.localModel;
    if(this.requestedModel&&this.requestedModel!==this.localModel){
      if(!this.models.includes(this.requestedModel))throw new Error('当前 Google Antigravity 账户未提供所选模型');
      if(config){
        const updated=await this.request('session/set_config_option',{sessionId:id,configId:config.id,value:this.requestedModel},signal);
        if(modelConfig(updated)?.currentValue!==this.requestedModel)throw new Error('Google Antigravity 未确认使用所选模型');
      }else{
        await this.request('session/set_model',{sessionId:id,modelId:this.requestedModel},signal);
      }
      this.model=this.requestedModel;
    }
    return id;
  }
  async exec(text:string,signal:AbortSignal):Promise<AgentTurnResult>{
    if(!this.sessionId||this.turn)throw new Error('Google Antigravity 会话当前不可用');
    this.turn={messages:new Map(),calls:new Map()};
    if(this.model)this.observeModel?.(this.model,'google-antigravity');
    try{
      const prompt=[{type:'text',text}];
      const result=await this.request('session/prompt',{sessionId:this.sessionId,prompt},signal);
      const usage=result?.usage;
      if(Number.isSafeInteger(usage?.inputTokens)&&usage.inputTokens>=0&&Number.isSafeInteger(usage.outputTokens)&&usage.outputTokens>=0)
        this.publish({kind:'usage',usage:{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens}});
      if(result?.stopReason==='end_turn'||result?.stopReason==='cancelled')return {stopReason:result.stopReason};
      return {stopReason:'failed',error:'Google Antigravity 未完成本轮，请检查账户、模型和工具连接'};
    }finally{this.turn=undefined;}
  }
  private update(method:string,params:any){
    if(!this.turn||method!=='session/update'||params?.sessionId!==this.sessionId)return;
    const event=params.update;
    if(event?.sessionUpdate==='agent_message_chunk'&&event.content?.type==='text'&&typeof event.content.text==='string'){
      const messageId=typeof event.messageId==='string'?event.messageId:this.sessionId!;
      const current=this.turn.messages.get(messageId)??'';
      const delta=event.content.text.slice(0,Math.max(0,65536-current.length));
      if(delta){
        const messageText=current+delta;
        this.turn.messages.set(messageId,messageText);
        this.publish({kind:'text',text:delta,messageId,messageText});
      }
    }else if(['tool_call','tool_call_update'].includes(event?.sessionUpdate)&&typeof event.toolCallId==='string'){
      const calls=this.turn.calls;
      if(['completed','failed','cancelled'].includes(event.status)){
        if(calls.has(event.toolCallId))calls.set(event.toolCallId,false);
      }else if(event.sessionUpdate==='tool_call'&&this.scopedCall(event)&&!calls.has(event.toolCallId)&&calls.size<2048){
        calls.set(event.toolCallId,digest(event.rawInput));
      }
      this.publish({kind:event.sessionUpdate==='tool_call'?'tool':'tool_update',callId:event.toolCallId,
        title:typeof event.title==='string'?event.title:'Google Antigravity 工具',status:typeof event.status==='string'?event.status:'pending'});
    }
  }
  async steer(){return false;}
  async cancel(){if(this.turn&&this.sessionId&&!this.rpc.signal.aborted)this.rpc.notify('session/cancel',{sessionId:this.sessionId});}
  diagnostics(){return '';}
  async close(){await this.rpc.close();await rm(this.configFile,{force:true});}
}
