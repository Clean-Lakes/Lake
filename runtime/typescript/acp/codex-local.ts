import {readFileSync,existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {JsonRpcProcess} from './process';
import {parse} from 'smol-toml';
import {HttpError} from '../store';
import {isCodexModelId,isCodexReasoningEffort} from './codex-profile';
import type {CodexModelOption} from './types';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object=(value:unknown):Record<string,any>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,any>:{};
function merge(base:Record<string,any>,override:Record<string,any>){
  const result={...base};for(const [key,value] of Object.entries(override))result[key]=value&&typeof value==='object'&&!Array.isArray(value)?merge(object(result[key]),value):value;return result;
}
export type CodexLocalInfo={home:string;fingerprint:string;environment:NodeJS.ProcessEnv;mcpIds:string[];hooks:Record<string,unknown>};
export type CodexLocalConfiguration={model:string;models?:CodexModelOption[];provider:string;reasoningEffort?:string;authenticated:boolean;authMode:'chatgpt'|'api_key'|'provider'|'none';mcpIds:string[];hooks:Record<string,unknown>;environment:NodeJS.ProcessEnv};

async function listModels(connection:JsonRpcProcess,signal:AbortSignal) {
  const models=new Map<string,CodexModelOption>(),cursors=new Set<string>();
  let cursor:string|undefined,defaultModel:string|undefined;
  do {
    const page=await connection.request('model/list',{limit:100,cursor},signal);
    for(const raw of Array.isArray(page?.data)?page.data:[]){
      const option=object(raw),id=option.model??option.id;
      if(!isCodexModelId(id)||option.hidden===true||models.has(id))continue;
      const efforts=Array.isArray(option.supportedReasoningEfforts)?option.supportedReasoningEfforts:[];
      const reasoningEfforts=[...new Set(efforts.map(item=>object(item).reasoningEffort).filter(isCodexReasoningEffort))];
      const defaultReasoningEffort=isCodexReasoningEffort(option.defaultReasoningEffort)?option.defaultReasoningEffort:undefined;
      models.set(id,{id,reasoningEfforts,defaultReasoningEffort});
      if(option.isDefault===true)defaultModel=id;
    }
    cursor=typeof page?.nextCursor==='string'&&page.nextCursor?page.nextCursor:undefined;
    if(cursor){
      if(cursors.has(cursor))throw new Error('Codex 模型列表重复返回同一页');
      cursors.add(cursor);
    }
  }while(cursor);
  return {models:[...models.values()],defaultModel};
}

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
  async inspect(node:string,engine:string,directory:string,overrides:string[],signal:AbortSignal,
    options:{discoverModels?:boolean;knownDefaultModel?:string}={}):Promise<CodexLocalConfiguration>{
    const source=this.current(),env:NodeJS.ProcessEnv={...source.environment,TMPDIR:directory};
    const connection=new JsonRpcProcess({executable:node,args:[engine,...overrides,'app-server'],cwd:directory,env});
    try{
      await connection.request('initialize',{clientInfo:{name:'lake-codex-config',version:'1'},capabilities:null},signal);
      connection.notify('initialized');
      const result=await connection.request('config/read',{includeLayers:false},signal),config=object(result.config);
      this.secrets(config);
      const provider=typeof config.model_provider==='string'?config.model_provider:'openai',providerConfig=object(object(config.model_providers)[provider]);
      this.providerEnvironment(providerConfig,env);
      if(providerConfig.env_key&&!env[providerConfig.env_key])throw new HttpError(409,'本机 Codex provider 所需的环境凭据不可用，请检查本机 Codex 配置');
      const account=await connection.request('account/read',{refreshToken:false},signal);
      const authenticated=account.requiresOpenaiAuth===false||!!account.account;
      const authMode=account.account?.type==='chatgpt'?'chatgpt':account.account?.type==='apiKey'?'api_key':account.requiresOpenaiAuth===false?'provider':'none';
      let model=isCodexModelId(config.model)?config.model:undefined;
      let models:CodexModelOption[]|undefined;
      if((options.discoverModels&&authenticated)||(!model&&!options.knownDefaultModel)){
        try {
          const catalog=await listModels(connection,AbortSignal.any([signal,AbortSignal.timeout(12_000)]));
          models=catalog.models;
          model??=catalog.defaultModel;
        }catch{
          signal.throwIfAborted();
          // A configured default is usable even when the provider has no catalog.
        }
      }
      model??=options.knownDefaultModel;
      if(!model)throw new HttpError(409,'本机 Codex 没有返回可用的默认模型');
      return {model,models,provider,reasoningEffort:isCodexReasoningEffort(config.model_reasoning_effort)?config.model_reasoning_effort:undefined,
        authenticated,authMode,mcpIds:Object.keys(object(config.mcp_servers)),hooks:object(config.hooks),environment:env};
    }finally{await connection.close();}
  }
}

export function codexHomePresent(home:string){return existsSync(home);}
