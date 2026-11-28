import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import type {AgentActivity,AgentConnection,AgentLaunch,AgentTurnResult,ObserveAgentModel,ScopedStdioMcp} from './client';
import {isCliModelId} from './cli-profile';
import {privateFile} from './private';
import {JsonLineProcess} from './process';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const textLimit=65536;

/** Claude Code's documented headless JSON stream. Lake owns every business tool. */
export class ClaudeCode implements AgentConnection {
  private session?:{id:string;args:string[]};
  private process?:JsonLineProcess;
  constructor(private readonly launch:Omit<AgentLaunch,'args'>,private readonly publish:(event:AgentActivity)=>void,
    private readonly mcp:ScopedStdioMcp|undefined,private readonly model:string|undefined,private readonly observeModel:ObserveAgentModel){}

  async initialize(signal:AbortSignal){signal.throwIfAborted();return {streaming:true,resume:true,cancel:true};}

  async openSession(options:{cwd:string;threadId?:string;systemPrompt?:string},signal:AbortSignal){
    signal.throwIfAborted();
    if(this.session||options.threadId&&!uuid.test(options.threadId))throw new Error('Claude Code 会话标识无效');
    const id=options.threadId??randomUUID();
    const args=['-p','--bare','--restricted','--setting-sources','','--tools','','--strict-mcp-config','--no-chrome','--disable-slash-commands',
      '--settings',JSON.stringify({disableAllHooks:true,autoMemoryEnabled:false}),'--permission-mode','dontAsk',
      '--input-format','stream-json','--output-format','stream-json','--verbose','--include-partial-messages',
      options.threadId?'--resume':'--session-id',id];
    if(this.mcp){
      args.push('--mcp-config',JSON.stringify({mcpServers:{lake:{type:'stdio',command:this.mcp.command,args:this.mcp.args}}}),
        '--allowedTools',...this.mcp.tools.map(tool=>'mcp__lake__'+tool.name));
    }
    if(this.model)args.push('--model',this.model);
    if(options.systemPrompt){
      await privateFile(options.cwd,'system-prompt.txt',options.systemPrompt);
      args.push('--system-prompt-file',join(options.cwd,'system-prompt.txt'));
    }
    signal.throwIfAborted();
    this.session={id,args};return id;
  }

  async exec(text:string,signal:AbortSignal):Promise<AgentTurnResult>{
    signal.throwIfAborted();
    if(!this.session||this.process)throw new Error('Claude Code 会话当前不可用');
    const session=this.session;
    let messageId='',messageText='',hasText=false,providerError=false;
    const publishText=(id:string,body:string,delta:string)=>{
      hasText=true;
      this.publish({kind:'text',messageId:id,messageText:body,text:delta});
    };
    let cleanup=()=>{};
    try{return await new Promise<AgentTurnResult>((resolve,reject)=>{
      const process=new JsonLineProcess({...this.launch,args:session.args},frame=>{
        if(frame.session_id!==session.id||frame.parent_tool_use_id)return;
        if(frame.type==='system'&&frame.subtype==='init'){
          if(isCliModelId(frame.model))this.observeModel(frame.model,'anthropic');
        }else if(frame.type==='stream_event'){
          const event=frame.event;
          if(event?.type==='message_start'&&typeof event.message?.id==='string'){
            messageId=event.message.id;messageText='';
          }else if(event?.type==='content_block_delta'&&event.delta?.type==='text_delta'&&messageId&&typeof event.delta.text==='string'){
            const delta=event.delta.text.slice(0,Math.max(0,textLimit-messageText.length));
            if(delta){messageText+=delta;publishText(messageId,messageText,delta);}
          }
        }else if(frame.type==='assistant'&&frame.error){
          providerError=true;
        }else if(frame.type==='assistant'&&typeof frame.message?.id==='string'&&Array.isArray(frame.message.content)){
          const id=frame.message.id;
          const body=frame.message.content.filter((part:any)=>part?.type==='text'&&typeof part.text==='string')
            .map((part:any)=>part.text).join('').slice(0,textLimit);
          if(body&&(id!==messageId||body!==messageText))publishText(id,body,id===messageId&&body.startsWith(messageText)?body.slice(messageText.length):body);
          messageId=id;messageText=body;
        }else if(frame.type==='result'){
          const input=frame.usage?.input_tokens,output=frame.usage?.output_tokens;
          if(Number.isSafeInteger(input)&&input>=0&&Number.isSafeInteger(output)&&output>=0)
            this.publish({kind:'usage',usage:{inputTokens:input,outputTokens:output}});
          if(providerError||frame.subtype!=='success'||frame.is_error===true){resolve({stopReason:'failed',error:'Claude Code 未完成本轮，请检查账户、模型和工具连接'});return;}
          if(!hasText&&typeof frame.result==='string'&&frame.result)publishText(session.id,frame.result.slice(0,textLimit),frame.result.slice(0,textLimit));
          resolve({stopReason:'end_turn'});
        }
      });
      this.process=process;
      const stopped=()=>reject(new Error('Claude Code 连接在本轮结束前断开'));
      const abort=()=>reject(signal.reason);
      cleanup=()=>{process.signal.removeEventListener('abort',stopped);signal.removeEventListener('abort',abort);};
      process.signal.addEventListener('abort',stopped,{once:true});signal.addEventListener('abort',abort,{once:true});
      signal.throwIfAborted();
      process.send({type:'user',session_id:session.id,message:{role:'user',content:[{type:'text',text}]},parent_tool_use_id:null});
    });}finally{cleanup();}
  }
  async steer(){return false;}
  async cancel(){await this.close();}
  diagnostics(){return '';}
  async close(){await this.process?.close();}
}
