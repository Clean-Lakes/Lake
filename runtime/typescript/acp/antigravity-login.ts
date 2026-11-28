import {spawn} from 'node:child_process';
import {HttpError} from '../store';
import type {AgentLaunch} from './client';
import {antigravityProfileArgs} from './cli-profile';
import {stopAgentProcess} from './process';

const callback='https://antigravity.google/oauth-callback';
const failed='Google 授权未完成，请重新登录';

function googleAuthorizationUrl(line:string){
  if(!line.startsWith('https://accounts.google.com/')||line.length>8192)return;
  const url=URL.parse(line);
  if(url?.origin==='https://accounts.google.com'&&!url.username&&!url.password&&
    url.pathname==='/o/oauth2/auth'&&url.searchParams.get('redirect_uri')===callback&&
    url.searchParams.get('response_type')==='code'&&url.searchParams.get('state')&&url.searchParams.get('code_challenge'))
    return url;
}

export function antigravityAuthorizationCode(value:unknown,authorizationUrl:string){
  if(typeof value!=='string'||value.length>8192)throw new HttpError(400,'请输入 Google 授权码');
  let code=value.trim();
  if(code.startsWith('https://')){
    const url=URL.parse(code);
    if(!url||url.origin+url.pathname!==callback||url.username||url.password||
      url.searchParams.get('state')!==new URL(authorizationUrl).searchParams.get('state'))
      throw new HttpError(400,'授权结果与本次 Google 登录不匹配');
    code=url.searchParams.get('code')??'';
  }
  if(!/^[\w./~-]{1,2048}$/.test(code))throw new HttpError(400,'请输入有效的 Google 授权码');
  return code;
}

/** agy owns the browser authorization and credential exchange. Only its Google link is exposed. */
export function launchAntigravityLogin(launch:Omit<AgentLaunch,'args'>){
  const process=spawn(launch.executable,['acp',...antigravityProfileArgs(launch.env),'--disable-telemetry','--login'],{
    cwd:launch.cwd,env:launch.env,shell:false,detached:true,stdio:['pipe','pipe','ignore'],
  });
  let resolveLink!:(url:string)=>void,rejectLink!:(reason:Error)=>void,resolveExit!:(success:boolean)=>void;
  const authorization=new Promise<string>((resolve,reject)=>{resolveLink=resolve;rejectLink=reject;});
  const exited=new Promise<boolean>(resolve=>{resolveExit=resolve;});
  let settled=false,submitted=false,buffer='',closing:Promise<void>|undefined;
  const finish=(success:boolean)=>{
    settled=true;
    rejectLink(new HttpError(409,failed));
    resolveExit(success&&submitted);
  };
  process.once('error',()=>finish(false));
  process.once('close',code=>finish(code===0));
  process.stdin.on('error',()=>finish(false));
  process.stdout.on('error',()=>finish(false));
  process.stdout.setEncoding('utf8');
  process.stdout.on('data',(chunk:string)=>{
    if(settled)return;
    buffer+=chunk;
    if(buffer.length>65536){finish(false);return;}
    let newline:number;
    while((newline=buffer.indexOf('\n'))!==-1){
      const line=buffer.slice(0,newline).trim();
      buffer=buffer.slice(newline+1);
      const url=googleAuthorizationUrl(line);
      if(url){resolveLink(url.href);return;}
    }
  });
  return {
    authorization,
    exited,
    submit(code:string){
      if(settled||submitted)throw new HttpError(409,failed);
      submitted=true;
      process.stdin.end(code+'\n');
    },
    close(){
      if(!closing){finish(false);closing=stopAgentProcess(process);}
      return closing;
    },
  };
}
