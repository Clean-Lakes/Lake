import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {parse} from 'smol-toml';
import {HttpError} from '../store';

/** Codex app-server's configuration RPC omits the JSON-RPC envelope used by ACP.
 * This connection has no thread/prompt/tool methods and never starts a task. */
class CodexConfigurationReader {
  private sequence=0;
  private pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void}>();
  private buffer='';
  private child;
  private closed=false;
  constructor(node:string,args:string[],directory:string,env:NodeJS.ProcessEnv){
    this.child=spawn(node,args,{cwd:directory,env,shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','ignore']});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>{
      this.buffer+=chunk;if(Buffer.byteLength(this.buffer)>8*1024*1024){this.fail();return;}
      let newline:number;
      while((newline=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);
        try{const response=JSON.parse(line),pending=this.pending.get(response.id);if(!pending)continue;
          this.pending.delete(response.id);response.error?pending.reject(new Error('本机 Codex 配置读取失败')):pending.resolve(response.result);
        }catch{this.fail();}
      }
    });
    this.child.on('error',()=>this.fail());this.child.on('exit',()=>this.fail());this.child.stdin.on('error',()=>this.fail());
  }
  private fail(){this.closed=true;for(const pending of this.pending.values())pending.reject(new Error('无法读取本机 Codex 登录与配置'));this.pending.clear();}
  async request(method:'initialize'|'config/read'|'account/read'|'model/list',params:unknown,signal:AbortSignal){
    signal.throwIfAborted();if(this.closed)throw new Error('Codex 配置读取进程已结束');
    const id=++this.sequence;let timer:ReturnType<typeof setTimeout>|undefined;
    const abort=()=>{this.pending.get(id)?.reject(new Error('读取本机 Codex '+method+' 已取消或超时'));this.pending.delete(id);};
    try{return await new Promise<any>((resolve,reject)=>{this.pending.set(id,{resolve,reject});signal.addEventListener('abort',abort,{once:true});timer=setTimeout(abort,method==='initialize'?60000:15000);
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n');});}
    finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
  }
  async close(){
    this.fail();this.child.stdin.end();const pid=this.child.pid;if(!pid)return;
    const kill=(signal:NodeJS.Signals)=>{try{if(process.platform==='win32')this.child.kill(signal);else process.kill(-pid,signal);}catch{/* already stopped */}};
    kill('SIGTERM');if(this.child.exitCode===null)await Promise.race([new Promise<void>(resolve=>this.child.once('exit',()=>resolve())),new Promise<void>(resolve=>setTimeout(resolve,300))]);kill('SIGKILL');
  }
}

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
function merge(base:Record<string,any>,override:Record<string,any>){
  const result={...base};for(const [key,value] of Object.entries(override))result[key]=value&&typeof value==='object'&&!Array.isArray(value)?merge(object(result[key]),value):value;return result;
}
export type CodexLocalInfo={home:string;fingerprint:string;environment:NodeJS.ProcessEnv;mcpIds:string[];hooks:Record<string,unknown>};
export type CodexLocalConfiguration={model:string;provider:string;reasoningEffort?:string;authenticated:boolean;authMode:'chatgpt'|'api_key'|'provider'|'none';mcpIds:string[];hooks:Record<string,unknown>;environment:NodeJS.ProcessEnv};

/** Local secrets are registered in memory only. No source config/auth body is persisted. */
export class CodexLocalSource {
  readonly home:string;
  private cache?:{stamp:string;info:CodexLocalInfo};
  constructor(home:string|undefined,readonly registerSecret:(value:string)=>void){
    const path=home??process.env.CODEX_HOME??join(homedir(),'.codex');
    if(!isAbsolute(path)||/[\0\r\n]/.test(path))throw new HttpError(409,'本机 Codex Home 需要绝对路径');
    this.home=resolve(path);
  }
  private secrets(value:unknown,key=''){
    if(typeof value==='string'){
      if(/token|secret|password|api.?key|authorization|bearer|http_headers|env/i.test(key)&&value.length>=4)this.registerSecret(value);
      if(/url/i.test(key))try{const url=new URL(value);if(url.username||url.password||url.search){this.registerSecret(value);if(url.password)this.registerSecret(decodeURIComponent(url.password));for(const secret of url.searchParams.values())if(secret.length>=4)this.registerSecret(secret);}}catch{/* not a URL */}
    }else if(Array.isArray(value))for(const item of value)this.secrets(item,key);
    else for(const [name,item] of Object.entries(object(value)))this.secrets(item,key+'.'+name);
  }
  private read(path:string){
    try{return readFileSync(path,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw new HttpError(409,'无法读取本机 Codex 配置或登录记录');}
  }
  current():CodexLocalInfo{
    const user=this.read(join(this.home,'config.toml')),system=this.read('/etc/codex/config.toml'),authText=this.read(join(this.home,'auth.json'));
    const stamp=hash([user,system,authText,process.env]);
    if(this.cache?.stamp===stamp)return this.cache.info;
    let config:Record<string,any>,auth:Record<string,any>;
    try{config=merge(object(system?parse(system):{}),object(user?parse(user):{}));auth=object(authText?JSON.parse(authText):{});}
    catch{throw new HttpError(409,'本机 Codex 配置或登录记录格式无效，请在 Codex 中检查');}
    this.secrets(config);this.secrets(auth);
    const tokens=object(auth.tokens),mode=auth.auth_mode??(auth.OPENAI_API_KEY?'api_key':tokens.access_token?'chatgpt':'none');
    // Refreshing tokens for the same account must not invalidate an active task.
    const identity=mode==='chatgpt'?[mode,tokens.account_id??null,this.jwtSubject(tokens.id_token??tokens.access_token)]:[mode,auth.OPENAI_API_KEY??null];
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,LANG:process.env.LANG??'en_US.UTF-8',HOME:homedir(),CODEX_HOME:this.home,LAKE_TS_IMPORT_ONLY:'0'};
    for(const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','CODEX_CA_CERTIFICATE','SSL_CERT_FILE','SSL_CERT_DIR'])if(process.env[name])env[name]=process.env[name];
    const provider=object(object(config.model_providers)[config.model_provider??'openai']);
    this.providerEnvironment(provider,env);
    const info={home:this.home,fingerprint:hash([this.home,user,system,identity,Object.entries(env).filter(([name])=>name!=='PATH'&&name!=='LANG')]),environment:env,mcpIds:Object.keys(object(config.mcp_servers)),hooks:object(config.hooks)};
    this.cache={stamp,info};return info;
  }
  private jwtSubject(value:unknown){
    if(typeof value!=='string')return null;
    try{const payload=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString('utf8'));return payload.sub??payload['https://api.openai.com/auth']?.chatgpt_account_id??null;}catch{return null;}
  }
  private providerEnvironment(provider:Record<string,any>,env:NodeJS.ProcessEnv){
    for(const name of [provider.env_key,...Object.values(object(provider.env_http_headers))]){
      if(typeof name!=='string'||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))continue;
      const value=process.env[name];if(value){env[name]=value;this.registerSecret(value);}
    }
  }
  async inspect(node:string,engine:string,directory:string,overrides:string[],signal:AbortSignal):Promise<CodexLocalConfiguration>{
    const source=this.current(),env:NodeJS.ProcessEnv={...source.environment,TMPDIR:directory};
    const connection=new CodexConfigurationReader(node,[engine,...overrides,'app-server'],directory,env);
    try{
      await connection.request('initialize',{clientInfo:{name:'lake-codex-config',version:'1'},capabilities:null},signal);
      const result=await connection.request('config/read',{includeLayers:false},signal),config=object(result.config);
      this.secrets(config);
      const provider=typeof config.model_provider==='string'?config.model_provider:'openai',providerConfig=object(object(config.model_providers)[provider]);
      this.providerEnvironment(providerConfig,env);
      if(providerConfig.env_key&&!env[providerConfig.env_key])throw new HttpError(409,'本机 Codex provider 所需的环境凭据不可用，请检查本机 Codex 配置');
      const account=await connection.request('account/read',{refreshToken:false},signal);
      let model=typeof config.model==='string'?config.model:'';
      if(!model){const models=await connection.request('model/list',{},signal);model=models.data?.find((item:any)=>item.isDefault)?.id??'';}
      if(!model)throw new HttpError(409,'本机 Codex 没有返回可用的默认模型');
      const authenticated=account.requiresOpenaiAuth===false||!!account.account;
      const authMode=account.account?.type==='chatgpt'?'chatgpt':account.account?.type==='apiKey'?'api_key':account.requiresOpenaiAuth===false?'provider':'none';
      return {model,provider,reasoningEffort:typeof config.model_reasoning_effort==='string'?config.model_reasoning_effort:undefined,authenticated,authMode,mcpIds:Object.keys(object(config.mcp_servers)),hooks:object(config.hooks),environment:env};
    }finally{await connection.close();}
  }
}

export function codexHomePresent(home:string){return existsSync(home);}
export function shellQuote(value:string){return "'"+value.replaceAll("'","'\\''")+"'";}
