import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable,Writable } from 'node:stream';
import { agent,ndJsonStream,type AgentContext } from '@agentclientprotocol/sdk';
import { AgentRuntime,createSqliteSessionStore,createToolRegistry,InMemorySessionEventStore,
  type Model,type SessionId,type ProjectId,type ToolEntry } from '../sdk';

/** Thin ACP hosting of the pinned public runtime. No model or tool loop is reimplemented. */
export async function runRuntimeAgent(directory:string){
  await mkdir(directory,{recursive:true,mode:0o700});
  const sessions=await createSqliteSessionStore({dbPath:join(directory,'sessions.sqlite')});
  const runtimes=new Map<string,AgentRuntime>(),controllers=new Map<string,AbortController>();
  const makeRuntime=async(sessionId:string,client:AgentContext)=>{
    const existing=runtimes.get(sessionId);if(existing)return existing;
    const descriptor:any=await client.request('_lake/model_descriptor',{});
    const system:any=await client.request('_lake/system_prompt',{});
    const tools:any[]=await client.request('_lake/tools',{});
    const base=createToolRegistry();
    // Runtime bootstrap may register built-ins again. Keep every supplied tool
    // bound to its host proxy instead of allowing a local built-in replacement.
    const registry=new Proxy(base,{get(target,key){
      if(key==='register')return (entry:ToolEntry)=>{
        const definition=tools.find(tool=>tool.metadata.name===entry.metadata.name);
        if(!definition)return;
        return target.register({...definition,metadata:{...definition.metadata,needsApproval:false},permission:{needsApproval:false},
          handler:(input:any,context:any)=>client.request('_lake/tool',{name:entry.metadata.name,input,callId:context.toolCallId})},{silentDuplicateWarning:true});
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    for(const definition of tools){
      const metadata={...definition.metadata,needsApproval:false};
      const entry:ToolEntry={...definition,metadata,permission:{...definition.permission,needsApproval:false,alwaysAsk:undefined},
        handler:(input,context)=>client.request('_lake/tool',{name:metadata.name,input,callId:context.toolCallId})};
      registry.register(entry);
    }
    const remote:Model={...descriptor,bind(){return remote;},generateText:async request=>{const response:any=await client.request('_lake/generate',{request});if(response.error)throw new Error(response.error);return response.result;},
      async *streamText(){throw new Error('此 ACP 运行时使用原生非流式模型调用');}};
    const runtime=new AgentRuntime(sessionId as SessionId,{
      workingDirectory:directory,systemPrompt:system.text,
      modelStreaming:'off',toolAllowlist:tools.map(tool=>tool.metadata.name),toolConcurrency:{maxConcurrency:1},mode:'build',
      modelSelection:{providerId:descriptor.providerId,modelId:descriptor.modelId},
      titleGeneration:{enabled:false},targetCompletionVerification:{enabled:false},dynamicWorkflowEnabled:false,
      subagents:{enabled:false},mcp:{enabled:false},memory:{enabled:false},
    },{sessionStore:sessions,toolRegistry:registry,eventStore:new InMemorySessionEventStore({retention:'unbounded'}),modelFactory:()=>remote,
      // Only transport proxies exist here. The parent ToolExecutor applies the
      // actual permission rules and interactive broker for every business call.
      permissionBroker:{requestPermission:async request=>({decision:tools.some(tool=>tool.metadata.name===request.toolName)?'allow':'deny',resolvedAt:new Date()})}});
    await runtime.resumeFromStore();runtimes.set(sessionId,runtime);return runtime;
  };
  const app=agent()
    .onRequest('*',async ctx=>{
      if(ctx.method!=='_lake/steer')throw new Error('Unsupported ACP extension');
      const params=ctx.params as {sessionId:string;input:string;inputId:string};
      const runtime=runtimes.get(params.sessionId);
      if(!runtime||!controllers.has(params.sessionId))return {kind:'rejected'};
      return runtime.steerTurn({input:params.input,pendingInputId:params.inputId,delivery:'guide'});
    })
    .onRequest('initialize',()=>({protocolVersion:1,agentCapabilities:{loadSession:true,_meta:{'lake.managedTools':true}},
      agentInfo:{name:'lake-runtime-acp',version:'3.17.2'}}))
    .onRequest('session/new',async()=>{
      const sessionId=randomUUID();await sessions.createSession({id:sessionId as SessionId,projectID:'lake-acp' as ProjectId,directory,slug:sessionId,title:'Lake task',version:'3.17.2',
        permission:{scope:'session',version:1,allow:[{toolName:'*'}]}});return {sessionId};
    })
    .onRequest('session/load',async({params})=>{if(!await sessions.getSession(params.sessionId as SessionId))throw new Error('该执行上下文不存在');return {};})
    .onNotification('session/cancel',({params})=>{controllers.get(params.sessionId)?.abort(new Error('原任务已停止'));})
    .onRequest('session/prompt',async({params,client})=>{
      if(controllers.has(params.sessionId))throw new Error('该执行上下文仍在运行');
      const controller=new AbortController();controllers.set(params.sessionId,controller);
      try{
        const runtime=await makeRuntime(params.sessionId,client);
        const text=params.prompt.filter(block=>block.type==='text').map(block=>(block as {text:string}).text).join('\n');
        const result=await runtime.executeTurn(text,undefined,{abortSignal:controller.signal});
        if(result.response)await client.notify('session/update',{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:result.response}}});
        return {stopReason:controller.signal.aborted?'cancelled' as const:'end_turn' as const};
      }catch(error){let cause:unknown=error;for(let depth=0;depth<5&&cause instanceof Error;depth++,cause=cause.cause)console.error(cause.message);throw error;}
      finally{controllers.delete(params.sessionId);}
    });
  const connection=app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
  await connection.closed;
  for(const controller of controllers.values())controller.abort();
  await Promise.allSettled([...runtimes.values()].map(runtime=>runtime.close()));await sessions.close();
}
