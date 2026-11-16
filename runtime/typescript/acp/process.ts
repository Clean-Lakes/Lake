import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import type {AgentLaunch} from './client';

type Pending = {resolve:(value:any)=>void;reject:(error:Error)=>void};
type RpcId = string|number;
export type RpcHandlers = {
  notification?:(method:string,params:any)=>void;
  request?:(method:string,params:any,id:RpcId)=>Promise<unknown>;
};
const maxFrameBytes=8*1024*1024;
const failure=(reason:unknown)=>reason instanceof Error?reason:new Error('智能体连接已停止');

/** Owns one process and its NDJSON transport; no provider or task semantics. */
export class JsonRpcProcess {
  readonly process:ChildProcessWithoutNullStreams;
  private readonly controller=new AbortController();
  readonly signal=this.controller.signal;
  private sequence=0;
  private pending=new Map<number,Pending>();
  private requests=new Set<RpcId>();
  private buffer='';
  private stderr=Buffer.alloc(0);
  private closing?:Promise<void>;
  constructor(launch:AgentLaunch,private readonly handlers:RpcHandlers={}) {
    this.process=spawn(launch.executable,launch.args,{cwd:launch.cwd,env:launch.env,shell:false,
      detached:process.platform!=='win32',windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data',(chunk:string)=>this.receive(chunk));
    this.process.stderr.on('data',(chunk:Buffer)=>{this.stderr=Buffer.concat([this.stderr,chunk]).subarray(-65536);});
    this.process.stdin.on('error',()=>this.fail(new Error('智能体输入连接已断开')));
    this.process.stdout.on('error',()=>this.fail(new Error('智能体输出连接已断开')));
    this.process.once('error',()=>this.fail(new Error('无法启动智能体进程')));
    // close follows stdout drainage; exit can precede the final protocol frame.
    this.process.once('close',()=>this.fail(new Error('智能体进程已退出')));
  }
  private fail(error:Error) {
    if(this.signal.aborted)return;
    this.controller.abort(error);
    for(const pending of this.pending.values())pending.reject(error);
    this.pending.clear();this.buffer='';
  }
  private receive(chunk:string) {
    if(this.signal.aborted)return;
    this.buffer+=chunk;
    try {
      let newline:number;
      while((newline=this.buffer.indexOf('\n'))>=0) {
        const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
        if(Buffer.byteLength(line)>maxFrameBytes)throw new Error('智能体协议消息超过 8 MiB');
        if(line.trim())this.message(JSON.parse(line));
        if(this.signal.aborted)return;
      }
      if(Buffer.byteLength(this.buffer)>maxFrameBytes)throw new Error('智能体协议消息超过 8 MiB');
    }catch {this.fail(new Error('智能体返回了无效或过大的协议消息'));void this.close();}
  }
  private message(message:any) {
    if(!message||typeof message!=='object'||Array.isArray(message))throw new Error('Invalid RPC envelope');
    if(typeof message.method==='string') {
      if(message.id===undefined){this.handlers.notification?.(message.method,message.params);return;}
      if(!['string','number'].includes(typeof message.id)||this.requests.has(message.id)||this.requests.size>=256)throw new Error('Invalid RPC request ID');
      const id:RpcId=message.id;this.requests.add(id);
      void Promise.resolve().then(()=>{
        if(this.signal.aborted)throw failure(this.signal.reason);
        if(!this.handlers.request)throw new Error('Unsupported request');
        return this.handlers.request(message.method,message.params,id);
      }).then(result=>this.send({id,result}),()=>this.send({id,error:{code:-32601,message:'Lake 未提供该智能体请求'}}))
        .catch(()=>{}).finally(()=>this.requests.delete(id));
      return;
    }
    if(!Object.hasOwn(message,'result')&&!message.error)throw new Error('Invalid RPC response');
    const pending=this.pending.get(message.id);if(!pending)return;
    this.pending.delete(message.id);
    if(message.error)pending.reject(new Error(typeof message.error.message==='string'?message.error.message:'智能体请求失败'));
    else pending.resolve(message.result);
  }
  private send(message:unknown) {
    this.signal.throwIfAborted();
    const frame=JSON.stringify(message)+'\n';
    if(Buffer.byteLength(frame)>maxFrameBytes)throw new Error('智能体请求超过 8 MiB');
    this.process.stdin.write(frame);
  }
  notify(method:string,params?:unknown) {this.send({method,...(params===undefined?{}:{params})});}
  async request<T=any>(method:string,params:unknown,signal:AbortSignal,timeout=120000):Promise<T> {
    signal.throwIfAborted();this.signal.throwIfAborted();
    if(this.pending.size>=256)throw new Error('智能体待响应请求过多');
    const id=++this.sequence;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const abort=()=>{this.pending.get(id)?.reject(failure(signal.reason));this.pending.delete(id);};
    try {
      return await new Promise<T>((resolve,reject)=>{
        this.pending.set(id,{resolve,reject});
        signal.addEventListener('abort',abort,{once:true});
        timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('智能体 '+method+' 请求等待超时'));},timeout);
        try{signal.throwIfAborted();this.send({id,method,params});}catch(error){this.pending.delete(id);reject(failure(error));}
      });
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  diagnostics(){return this.stderr.toString('utf8');}
  close(){return this.closing??=this.end();}
  private async end() {
    this.fail(new Error('智能体连接已关闭'));
    this.process.stdin.end();
    const pid=this.process.pid;if(!pid)return;
    const kill=(signal:NodeJS.Signals)=>{
      try{if(process.platform==='win32')this.process.kill(signal);else process.kill(-pid,signal);}catch{/* Already reaped. */}
    };
    let timer:ReturnType<typeof setTimeout>|undefined;
    let onClose=()=>{};
    const exited=new Promise<void>(resolve=>{onClose=resolve;this.process.once('close',onClose);});
    kill('SIGTERM');
    try {
      if(this.process.exitCode===null&&this.process.signalCode===null)
        await Promise.race([exited,new Promise<void>(resolve=>{timer=setTimeout(resolve,300);})]);
    }finally{clearTimeout(timer);this.process.removeListener('close',onClose);kill('SIGKILL');}
  }
}
