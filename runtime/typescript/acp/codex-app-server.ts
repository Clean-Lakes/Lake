import type {AgentActivity,AgentConnection,AgentLaunch,AgentTurnResult} from './client';
import type {ExternalToolAction} from '../../../web-agent/shared/contracts';
import {isExternalToolName} from '../../../web-agent/shared/external-agents';
import {JsonRpcProcess} from './process';

type Tokens={inputTokens:number;outputTokens:number};
type Turn={id?:string;done:boolean;resolve:(result:AgentTurnResult)=>void;reject:(error:Error)=>void;
  confirmed:Promise<void>;confirm:()=>void;mcpCalls:Map<string,{server:string;tool:string;pending:boolean}>;
  buffered:Array<{method:string;params:any}>;bytes:number;messages:Map<string,string>;text:string;baseline?:Tokens;
  inputs:Map<string,{text:string;consumed:boolean}>;};
const tokens=(value:any):Tokens|undefined=>value&&Number.isSafeInteger(value.inputTokens)&&value.inputTokens>=0&&Number.isSafeInteger(value.outputTokens)&&value.outputTokens>=0?
  {inputTokens:value.inputTokens,outputTokens:value.outputTokens}:undefined;
type McpGate={server:string;tools:ReadonlySet<string>;guard:()=>void;displayName?:(serverId:string)=>string|undefined};

const codexActions:Record<string,string>={commandExecution:'terminal_execute_command',fileChange:'edit_file',webSearch:'web_search',collabAgentToolCall:'Agent'};

function publicToolAction(item:any,mcp?:McpGate):ExternalToolAction|undefined{
 if(item.type==='mcpToolCall'&&isExternalToolName(item.tool)){
  if(mcp&&mcp.server===item.server&&mcp.tools.has(item.tool)&&['call_mcp_tool','list_mcp_tools'].includes(item.tool)&&isExternalToolName(item.arguments?.server_id)){
   // Resolve only the project catalog label. Invocation inputs and capability decisions stay in the broker.
   let integration:string|undefined;
   try{integration=mcp.displayName?.(item.arguments.server_id);}catch{/* Discovery may be unavailable. */}
   if(integration)return {tool:item.tool==='call_mcp_tool'&&isExternalToolName(item.arguments.tool)?item.arguments.tool:item.tool,integration};
  }
  return {tool:item.tool,...(item.server!=='lake'&&isExternalToolName(item.server)&&{integration:item.server})};
 }
 if(item.type==='dynamicToolCall'&&isExternalToolName(item.tool))return {tool:item.tool};
 const tool=Object.hasOwn(codexActions,item.type)?codexActions[item.type]:undefined;
 return tool?{tool}:undefined;
}

/** Official Codex App Server. JSON-RPC version headers are omitted. */
export class CodexAppServer implements AgentConnection {
  private readonly rpc:JsonRpcProcess;
  private initialized=false;
  private threadId?:string;
  private turn?:Turn;
  private totalTokens?:Tokens;
  private broken=false;
  constructor(private readonly launch:AgentLaunch,private readonly activity:(event:AgentActivity)=>void,private readonly mcp?:McpGate) {
    this.rpc=new JsonRpcProcess(launch,{
      notification:(method,params)=>this.notification(method,params),
      request:async(method,params)=>{
        // Business tools execute only through the task-bound MCP bridge.
        if(method==='item/commandExecution/requestApproval'||method==='item/fileChange/requestApproval')return {decision:'decline'};
        if(method==='mcpServer/elicitation/request')return this.approveMcp(params);
        throw new Error('Codex 请求不在 Lake 工具边界中');
      },
    });
    this.rpc.signal.addEventListener('abort',()=>this.turn?.reject(this.rpc.signal.reason),{once:true});
  }
  private async approveMcp(params:any) {
    const cancelled={action:'cancel',content:null,_meta:null};
    const turn=this.turn;if(!turn||!this.mcp)return cancelled;
    await turn.confirmed;
    if(this.turn!==turn||turn.done||params?.threadId!==this.threadId||params.turnId!==turn.id||
      params.serverName!==this.mcp.server||!['form','openai/form','openaiForm'].includes(params.mode)||params._meta?.codex_approval_kind!=='mcp_tool_call')return cancelled;
    // App Server form elicitations can omit the MCP call ID. Consume
    // one observed call for this exact thread/turn/server. This admits only the
    // private transport; ToolExecutor checks the actual business action.
    const call=[...turn.mcpCalls.values()].find(call=>call.pending&&call.server===this.mcp!.server&&this.mcp!.tools.has(call.tool));
    if(!call)return cancelled;
    call.pending=false;this.mcp.guard();
    return {action:'accept',content:null,_meta:null};
  }
  async initialize(signal:AbortSignal) {
    if(this.initialized)throw new Error('Codex 连接已经初始化');
    const serverInfo=await this.rpc.request('initialize',{clientInfo:{name:'lake',title:'Lake',version:'1'},capabilities:{experimentalApi:true}},signal);
    this.rpc.notify('initialized');this.initialized=true;
    return {runtime:'codex-app-server',serverInfo,resume:true,streaming:true,cancel:true};
  }
  async openSession(options:{cwd:string;threadId?:string;systemPrompt?:string},signal:AbortSignal) {
    if(!this.initialized||this.threadId)throw new Error('Codex 线程状态不允许创建或载入');
    const params={cwd:options.cwd,approvalPolicy:'on-request',approvalsReviewer:'user',sandbox:'read-only',config:this.launch.threadConfig??{},
      ...(options.systemPrompt?{developerInstructions:options.systemPrompt}:{}),
      ...(options.threadId?{threadId:options.threadId}:{})};
    // Resume may replay usage before its response, but never replay messages.
    this.threadId=options.threadId;
    this.totalTokens=options.threadId?undefined:{inputTokens:0,outputTokens:0};
    const result=await this.rpc.request(options.threadId?'thread/resume':'thread/start',params,signal);
    const id=result?.thread?.id;
    if(typeof id!=='string'||!id||options.threadId&&id!==options.threadId)throw new Error('Codex 没有返回对应线程');
    if(this.launch.observed&&typeof result.model==='string'&&result.model!==this.launch.observed.model)throw new Error('Codex 线程模型与冻结配置不一致');
    this.threadId=id;return id;
  }
  async exec(text:string,signal:AbortSignal):Promise<AgentTurnResult> {
    signal.throwIfAborted();
    if(!this.threadId||this.turn||this.broken)throw new Error('Codex 线程不可用或已有轮次运行');
    let turn!:Turn;
    let confirm!:()=>void,failConfirm!:(error:Error)=>void;
    const confirmed=new Promise<void>((resolve,reject)=>{confirm=resolve;failConfirm=reject;});void confirmed.catch(()=>{});
    const completed=new Promise<AgentTurnResult>((resolve,reject)=>{turn={done:false,
      resolve:result=>{if(!turn.done){turn.done=true;resolve(result);}},
      reject:error=>{if(!turn.done){turn.done=true;failConfirm(error);reject(error);}},
      confirmed,confirm,mcpCalls:new Map(),inputs:new Map(),
      buffered:[],bytes:0,messages:new Map(),text:'',baseline:this.totalTokens};});
    void completed.catch(()=>{});
    this.turn=turn;
    const abort=()=>turn.reject(signal.reason instanceof Error?signal.reason:new Error('Codex 轮次已取消'));
    signal.addEventListener('abort',abort,{once:true});
    try {
      const result=await this.rpc.request('turn/start',{threadId:this.threadId,input:[{type:'text',text}],approvalPolicy:'on-request',approvalsReviewer:'user'},signal,120000);
      if(typeof result?.turn?.id!=='string'||!result.turn.id)throw new Error('Codex 没有确认本次轮次');
      turn.id=result.turn.id;
      for(const item of turn.buffered)this.route(turn,item.method,item.params);
      turn.buffered=[];turn.bytes=0;
      turn.confirm();
      return await completed;
    }catch(error){this.broken=true;turn.reject(error instanceof Error?error:new Error('Codex 轮次失败'));throw error;
    }finally{signal.removeEventListener('abort',abort);if(this.turn===turn)this.turn=undefined;}
  }
  private notification(method:string,params:any) {
    if(!params||params.threadId!==this.threadId)return;
    const turn=this.turn;
    if(!turn) {
      if(method==='thread/tokenUsage/updated')this.totalTokens=tokens(params.tokenUsage?.total);
      return;
    }
    if(turn.done)return;
    if(!turn.id) {
      turn.bytes+=Buffer.byteLength(JSON.stringify(params));
      if(turn.buffered.length>=2048||turn.bytes>8*1024*1024){turn.reject(new Error('Codex 未确认轮次的输出过多'));void this.rpc.close();return;}
      turn.buffered.push({method,params});return;
    }
    this.route(turn,method,params);
  }
  async steer(text:string,inputId:string,signal:AbortSignal) {
    signal.throwIfAborted();
    const turn=this.turn;
    if(!turn||turn.done||this.broken)return false;
    await turn.confirmed;
    if(this.turn!==turn||turn.done||!turn.id)return false;
    const old=turn.inputs.get(inputId);
    if(old){if(old.text!==text)throw new Error('Codex 补充输入身份不匹配');return true;}
    turn.inputs.set(inputId,{text,consumed:false});
    try{
      const result=await this.rpc.request('turn/steer',{threadId:this.threadId,expectedTurnId:turn.id,
        clientUserMessageId:inputId,input:[{type:'text',text,text_elements:[]}]},signal,10000);
      if(result?.turnId!==turn.id)throw new Error('Codex 没有确认对应的补充轮次');
    }catch(error){
      if((error as any)?.code===-32600&&!turn.inputs.get(inputId)?.consumed){turn.inputs.delete(inputId);return false;}
      throw error;
    }
    // Acceptance is only queue admission. A matching userMessage item below
    // proves this input entered the current turn's model context.
    return true;
  }
  private messageText(turn:Turn,id:string,text:string) {
    const changed=!turn.messages.has(id)||turn.messages.get(id)!==text;
    turn.messages.set(id,text);
    const combined=[...turn.messages.values()].join('');
    if(Buffer.byteLength(combined)>1024*1024){turn.reject(new Error('Codex 正文超过本次输出上限'));void this.rpc.close();return;}
    if(changed){turn.text=combined;this.activity({kind:'text',text:combined,messageId:id,messageText:text});}
  }
  private route(turn:Turn,method:string,params:any) {
    const id=method==='turn/completed'?params.turn?.id:params.turnId;
    if(turn.done||id!==turn.id)return;
    if(method==='item/agentMessage/delta'&&typeof params.itemId==='string'&&typeof params.delta==='string')
      this.messageText(turn,params.itemId,(turn.messages.get(params.itemId)??'')+params.delta);
    else if(method==='item/started'||method==='item/completed') {
      const item=params.item;if(!item||typeof item.id!=='string')return;
      if(item.type==='userMessage'&&typeof item.clientId==='string') {
        const input=turn.inputs.get(item.clientId);
        if(input&&!input.consumed&&Array.isArray(item.content)&&item.content.length===1&&
            item.content[0]?.type==='text'&&item.content[0].text===input.text){
          input.consumed=true;this.activity({kind:'input',inputId:item.clientId});
        }
      }
      if(item.type==='mcpToolCall') {
        if(method==='item/started'&&!turn.mcpCalls.has(item.id))turn.mcpCalls.set(item.id,{server:item.server,tool:item.tool,pending:true});
        if(method==='item/completed'){const call=turn.mcpCalls.get(item.id);if(call)call.pending=false;}
      }
      if(item.type==='agentMessage'&&method==='item/completed'&&typeof item.text==='string')this.messageText(turn,item.id,item.text);
      else if(['mcpToolCall','commandExecution','fileChange','dynamicToolCall','collabAgentToolCall','webSearch'].includes(item.type))
        this.activity({kind:method==='item/started'?'tool':'tool_update',callId:item.id,
          title:item.type==='mcpToolCall'?item.server==='lake'?item.tool:item.server+' / '+item.tool:item.tool??item.command??item.type,
          action:publicToolAction(item,this.mcp),
          status:method==='item/started'?'running':['failed','declined','cancelled','interrupted'].includes(item.status)||item.success===false?'failed':'completed'});
    }else if(method==='thread/tokenUsage/updated') {
      const total=tokens(params.tokenUsage?.total);if(!total)return;
      this.totalTokens=total;
      if(turn.baseline&&total.inputTokens>=turn.baseline.inputTokens&&total.outputTokens>=turn.baseline.outputTokens)
        this.activity({kind:'usage',usage:{inputTokens:total.inputTokens-turn.baseline.inputTokens,outputTokens:total.outputTokens-turn.baseline.outputTokens}});
    }else if(method==='turn/completed') {
      for(const item of params.turn.items??[])if(item.type==='agentMessage'&&typeof item.id==='string'&&typeof item.text==='string')this.messageText(turn,item.id,item.text);
      const status=params.turn.status;
      if(!['completed','interrupted','failed'].includes(status)){turn.reject(new Error('Codex 返回了无效终态'));return;}
      turn.resolve({stopReason:status==='completed'?'end_turn':status==='interrupted'?'cancelled':'failed',
        ...(typeof params.turn.error?.message==='string'?{error:params.turn.error.message}:{})});
    }
  }
  async cancel() {
    if(!this.threadId||!this.turn?.id||this.rpc.signal.aborted)return;
    await this.rpc.request('turn/interrupt',{threadId:this.threadId,turnId:this.turn.id},AbortSignal.timeout(500),500).catch(()=>{});
  }
  diagnostics(){return this.rpc.diagnostics();}
  close(){return this.rpc.close();}
}
