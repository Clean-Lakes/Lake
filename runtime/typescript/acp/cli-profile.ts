import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {accessSync,constants,lstatSync,realpathSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join} from 'node:path';
import {promisify} from 'node:util';
import {HttpError} from '../store';
import {externalProducts} from './catalog';
import {privateFile,privatePath} from './private';
import type {CliAgentId,CliAgentProfile} from './types';

const run = promisify(execFile);
const binaries:Record<CliAgentId,string>={'claude-code':'claude',antigravity:'agy'};
export const cliRuntimeKinds={'claude-code':'claude-code-cli',antigravity:'antigravity-acp'} as const;
export function isCliModelId(value:unknown):value is string {
  return typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:+/@-]{0,199}$/.test(value);
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

export function cliSecretId(projectId:string,id:CliAgentId){
  return `external-${id}-${createHash('sha256').update(projectId).digest('hex')}`;
}
export function cliSource(home:string,projectId:string,id:CliAgentId,path?:string){
  const executable=cliExecutable(home,id,path);
  let keyIdentity:string|undefined;
  try {
    const info=lstatSync(join(home,'secrets',`model-${cliSecretId(projectId,id)}.json`));
    if(info.isFile()&&(info.mode&0o077)===0&&info.uid===process.getuid?.())keyIdentity=JSON.stringify([info.dev,info.ino,info.mtimeMs,info.ctimeMs]);
  }catch {/* A missing or unreadable credential is not configured. */}
  const fingerprint=createHash('sha256').update(JSON.stringify([executable?.fingerprint,keyIdentity])).digest('hex');
  return {executable,keyConfigured:!!keyIdentity,fingerprint};
}

export async function cliEnvironment(home:string,profile:CliAgentProfile,cwd:string) {
  const {executable,fingerprint}=cliSource(home,profile.projectId,profile.id,profile.executablePath);
  if(!executable)throw new HttpError(409,`未找到 ${externalProducts[profile.id].name} CLI，请安装或填写路径`);
  if(fingerprint!==profile.sourceFingerprint)throw new HttpError(409,'CLI 配置已变化，请重新检测连接');
  const configHome=await privatePath(cwd,'provider-home');
  const temp=await privatePath(cwd,'tmp');
  const path=dirname(executable.path)+':/usr/bin:/bin:/usr/sbin:/sbin';
  const env:NodeJS.ProcessEnv={HOME:configHome,TMPDIR:temp,PATH:path,LANG:'en_US.UTF-8'};
  if(profile.id==='claude-code'){
    env.CLAUDE_CONFIG_DIR=await privatePath(configHome,'.claude');
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1';
    env.DISABLE_AUTOUPDATER='1';
  }else{
    env.AGY_CLI_DISABLE_AUTO_UPDATE='true';
    const config=await privatePath(configHome,'.gemini','antigravity-cli');
    // The only registered MCP server is supplied by Lake for each session.
    await privateFile(config,'settings.json',JSON.stringify({
      modelProvider:'gemini',toolPermission:'strict',allowNonWorkspaceAccess:false,
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
