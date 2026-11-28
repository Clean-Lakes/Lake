import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync,constants,lstatSync,realpathSync,statSync} from 'node:fs';
import {readlink,symlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {cliDefaultAuthentication,type ClaudeGateway,type CliAuthentication} from '../../../web-agent/shared/external-agents';
import {HttpError} from '../store';
import {externalProducts} from './catalog';
import {privateFile,privatePath} from './private';
import type {CliAgentId,CliAgentProfile} from './types';

const run = promisify(execFile);
const binaries:Record<CliAgentId,string>={'claude-code':'claude',antigravity:'agy'};
export const cliRuntimeKinds={'claude-code':'claude-code-cli',antigravity:'antigravity-acp'} as const;
export const antigravityAppData = 'antigravity-acp';
export function isCliModelId(value:unknown):value is string {
  return typeof value==='string'&&value.length<=200&&/^~?[a-zA-Z0-9][a-zA-Z0-9_.:+/@-]*$/.test(value);
}
export function isCliReasoningEffort(value:unknown):value is string {
  return typeof value==='string'&&/^[a-z][a-z0-9_-]{0,31}$/i.test(value);
}
export function cliExecutable(home:string,id:CliAgentId,custom?:string) {
  const folders=[join(home,'external-agents','adapters',id,'bin'),join(homedir(),'.local','bin'),'/opt/homebrew/bin','/usr/local/bin',...(process.env.PATH??'').split(':')];
  for(const path of custom?[custom]:folders.filter(folder=>isAbsolute(folder)).map(folder=>join(folder,binaries[id]))){
    try {
      const resolved=realpathSync(path),stat=statSync(resolved);
      if(!stat.isFile())continue;
      accessSync(resolved,constants.X_OK);
      return {path:resolved,fingerprint:createHash('sha256').update(JSON.stringify([resolved,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs])).digest('hex')};
    }catch {/* A missing candidate is represented by connection status. */}
  }
}

export function isCliAuthentication(id:CliAgentId,value:unknown):value is CliAuthentication {
  return value===cliDefaultAuthentication[id]||value==='cli-api-key'||id==='claude-code'&&value==='claude-custom-api';
}

export function claudeGatewayConfig(value:unknown):ClaudeGateway {
  const settings=value as Partial<ClaudeGateway>|null;
  const address=settings?.baseURL;
  const invalidAddress='API 基础地址需为 HTTP(S) 地址，且不能包含凭据、查询参数或片段';
  if(typeof address!=='string'||address.length>2048||/[?#\s]/.test(address))throw new HttpError(400,invalidAddress);
  let url:URL;
  try{url=new URL(address);}catch{throw new HttpError(400,invalidAddress);}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new HttpError(400,invalidAddress);
  const credentialHeader=settings?.credentialHeader;
  if(credentialHeader!=='authorization'&&credentialHeader!=='x-api-key')throw new HttpError(400,'请选择服务商支持的 API Key 发送方式');
  // The Claude SDK appends /v1/messages to this base.
  const path=url.pathname.replace(/\/+$/,'').replace(/\/v1(?:\/messages)?$/,'');
  const baseURL=url.origin+path;
  return {baseURL,credentialHeader};
}

type CliSourceSettings=Pick<CliAgentProfile,'projectId'|'id'|'executablePath'|'authentication'|'claudeGateway'>;
export function cliSecretId(profile:CliSourceSettings){
  const gateway=profile.authentication==='claude-custom-api'?profile.claudeGateway:undefined;
  const identity=gateway?JSON.stringify([profile.projectId,gateway.baseURL,gateway.credentialHeader]):profile.projectId;
  const prefix=gateway?'external-claude-gateway':`external-${profile.id}`;
  return `${prefix}-${createHash('sha256').update(identity).digest('hex')}`;
}
function localClaudeConfig(){
  const configured=process.env.CLAUDE_CONFIG_DIR;
  return configured&&isAbsolute(configured)?configured:undefined;
}

export function cliSource(home:string,profile:CliSourceSettings){
  const {id,executablePath,authentication,claudeGateway}=profile;
  const executable=cliExecutable(home,id,executablePath);
  let keyIdentity:string|undefined;
  try {
    const info=lstatSync(join(home,'secrets',`model-${cliSecretId(profile)}.json`));
    if(info.isFile()&&(info.mode&0o077)===0&&info.uid===process.getuid?.())keyIdentity=JSON.stringify([info.dev,info.ino,info.mtimeMs,info.ctimeMs]);
  }catch {/* A missing or unreadable credential is not configured. */}
  const source=authentication==='claude-custom-api'?[executable?.fingerprint,authentication,claudeGateway,keyIdentity]:
    authentication==='cli-api-key'?[executable?.fingerprint,keyIdentity]:
    [executable?.fingerprint,authentication,authentication==='claude-local'?localClaudeConfig():undefined];
  const fingerprint=createHash('sha256').update(JSON.stringify(source)).digest('hex');
  return {executable,keyConfigured:!!keyIdentity,fingerprint};
}

export function antigravityCredentials(home:string,projectId:string,loginId:string){
  return privatePath(home,'secrets','antigravity',projectId,loginId);
}

export function antigravityProfileArgs(env:NodeJS.ProcessEnv){
  return env.GEMINI_HOME?['--gemini-dir',env.GEMINI_HOME,'--app-data-dir',antigravityAppData]:[];
}

export async function cliEnvironment(home:string,profile:CliAgentProfile,cwd:string,googleLoginId=profile.googleLoginId) {
  const {executable,fingerprint}=cliSource(home,profile);
  if(!executable)throw new HttpError(409,`未找到 ${externalProducts[profile.id].name} CLI，请安装或填写路径`);
  if(fingerprint!==profile.sourceFingerprint)throw new HttpError(409,'CLI 配置已变化，请重新检测连接');
  const configHome=await privatePath(cwd,'provider-home');
  const temp=await privatePath(cwd,'tmp');
  const path=dirname(executable.path)+':/usr/bin:/bin:/usr/sbin:/sbin';
  const env:NodeJS.ProcessEnv={HOME:configHome,TMPDIR:temp,PATH:path,LANG:'en_US.UTF-8'};
  if(profile.id==='claude-code'){
    if(profile.authentication==='claude-local'){
      env.HOME=homedir();
      const config=localClaudeConfig();
      if(config)env.CLAUDE_CONFIG_DIR=config;
    }else env.CLAUDE_CONFIG_DIR=await privatePath(configHome,'.claude');
    env.ENABLE_CLAUDEAI_MCP_SERVERS='false';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
    env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='1';
    env.DISABLE_AUTOUPDATER='1';
  }else{
    env.AGY_CLI_DISABLE_AUTO_UPDATE='true';
    const google=profile.authentication==='antigravity-google';
    const gemini=await privatePath(configHome,'.gemini');
    const config=google&&googleLoginId?await antigravityCredentials(home,profile.projectId,googleLoginId):
      await privatePath(gemini,google?antigravityAppData:'antigravity-cli');
    if(google){
      env.GEMINI_HOME=gemini;
      env.AGY_ACP_FORCE_FILE_STORAGE='1';
      // agy 1.5 uses its per-profile file for remote sign-in instead of the system keyring.
      env.SSH_CONNECTION='127.0.0.1 0 127.0.0.1 0';
      if(googleLoginId){
        const link=join(gemini,antigravityAppData);
        await symlink(config,link,'dir').catch(async error=>{
          if(error.code!=='EEXIST'||await readlink(link)!==config)throw error;
        });
      }
    }
    // The only registered MCP server is supplied by Lake for each session.
    await privateFile(config,'settings.json',JSON.stringify({
      ...(google?{auth:{type:'oauth-personal'}}:{modelProvider:'gemini'}),toolPermission:'strict',allowNonWorkspaceAccess:false,
      permissions:{ask:['mcp(*)'],deny:['command(*)','unsandboxed(*)','read_file(*)','write_file(*)','read_url(*)','execute_url(*)']},
    }));
  }
  return {executable:executable.path,env,cwd};
}

type CommandEnvironment={executable:string;env:NodeJS.ProcessEnv;cwd:string};
export async function cliVersion(id:CliAgentId,environment:CommandEnvironment,signal:AbortSignal) {
  const version=await run(environment.executable,['--version'],{cwd:environment.cwd,env:environment.env,signal,timeout:8000,maxBuffer:65536})
    .then(({stdout})=>stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1],()=>undefined);
  signal.throwIfAborted();
  const minimum=externalProducts[id].version;
  const parts=version?.split('.').map(Number),required=minimum.split('.').map(Number);
  const change=parts?.findIndex((part,index)=>part!==required[index])??-1;
  return {version,supported:!!parts&&(change===-1||parts[change]>required[change])};
}
