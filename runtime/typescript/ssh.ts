import {networkProbe, networkProbeProgram, networkProbeShell} from "./network-probe";
import {directoryProcessSample} from "./process-sampling";
import {Client, utils, type ClientChannel} from 'ssh2';
import {EventEmitter} from 'node:events';
import {createHash,createHmac,timingSafeEqual} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {isIP} from 'node:net';
import type {Resource,SSHConnection,SSHHostKeyTrust} from '../../web-agent/shared/contracts';
import {HttpError,id,LakeStore} from './store';
import type {LakeSecurity} from './security';
import {digest} from './tasks';

export type TerminalDevice={pid?:number;readonly error?:string;write(data:string):void;resize(cols:number,rows:number):void;kill(signal?:string):void;
 onData(callback:(data:string)=>void):unknown;onExit(callback:(event:{exitCode:number;signal?:number})=>void):unknown};
type Prompt={public:SSHHostKeyTrust;resourceId:string;revision:string;pinHash:string;key:Buffer;resolve:(accept:boolean)=>void};
const inside=(root:string,path:string)=>path===root||path.startsWith(root+sep);
const quote=(value:string)=>"'"+value.replaceAll("'","'\"'\"'")+"'";
const canonicalHost=(host:string)=>host.toLowerCase().trim().replace(/\.$/,'');
const fingerprint=(key:Buffer)=>'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'');
const profiles={
 system:"command -p uname -s; command -p uptime; command -p df -Pk /; if [ -r /proc/meminfo ]; then command -p head -n 5 /proc/meminfo; elif [ -x /usr/bin/vm_stat ]; then /usr/bin/vm_stat; fi",
 disks:"command -p df -Pk",
 processes:"case $(command -p uname -s) in Linux) command -p ps -eo pid,ppid,pcpu,pmem,comm --sort=-pcpu | command -p head -n 21;; Darwin) command -p ps -axo pid,ppid,pcpu,pmem,comm | command -p head -n 21;; *) printf 'Unsupported process profile\\n'; exit 64;; esac",
} as const;

/** SSH uses saved Dev credentials and exact host pins; model text never supplies authentication or commands. */
export class LakeSSH {
 private prompts=new Map<string,Prompt>();
 private clients=new Set<Client>();
 private peerKeys=new WeakMap<Client,string>();
 private secrets=new Set<string>();
 private closed=false;
 constructor(readonly store:LakeStore,readonly security:LakeSecurity,readonly notify:(session:string)=>void,readonly redact:(value:string)=>string,readonly registerSecret?:(value:string)=>void){}
 private privateFile(value:string,maximum=1024*1024) {
  const root=join(this.store.home,'secrets'),path=isAbsolute(value)?value:resolve(root,value);
  const parent=lstatSync(root),info=lstatSync(path);
  if(!inside(root,path)||!inside(realpathSync(root),realpathSync(path))||parent.isSymbolicLink()||!parent.isDirectory()||parent.mode&0o077||
   !info.isFile()||info.isSymbolicLink()||info.mode&0o077||info.size>maximum||process.platform!=='win32'&&(parent.uid!==process.getuid?.()||info.uid!==process.getuid?.()))
   throw new HttpError(409,'SSH 凭据或主机记录须为此 Dev Home 内的私有文件');
  return path;
 }
 configuration(value:any):SSHConnection {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new HttpError(400,'SSH 配置无效');
  const config:SSHConnection={host:String(value.host??''),port:value.port??22,username:String(value.username??''),authMethod:value.authMethod??'key',shell:value.shell??'bash'};
  if(!config.host||config.host.length>253||!isIP(config.host)&&!/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*)$/.test(config.host)||
   !Number.isSafeInteger(config.port)||config.port<1||config.port>65535||!/^[a-zA-Z0-9_.@-]{1,128}$/.test(config.username)||
   !['key','password'].includes(config.authMethod!)||!['sh','bash','zsh','fish'].includes(config.shell!))throw new HttpError(400,'SSH 地址、端口、用户名或 Shell 无效');
  if(value.credentialRef){config.credentialRef=String(value.credentialRef);this.privateFile(config.credentialRef,4096);}
  if(config.authMethod==='key'){config.identityFile=String(value.identityFile??'');if(!config.identityFile)throw new HttpError(409,'SSH 私钥引用缺失');this.privateFile(config.identityFile);}
  else if(!config.credentialRef)throw new HttpError(409,'SSH 密码引用缺失');
  return config;
 }
 private atomic(path:string,value:string|Buffer) {
  const root=join(this.store.home,'secrets');mkdirSync(root,{recursive:true,mode:0o700});
  const info=lstatSync(root);if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||process.platform!=='win32'&&info.uid!==process.getuid?.())throw new HttpError(409,'Dev 凭据目录权限无效');
  if(existsSync(path))this.privateFile(path);
  const temporary=join(root,'.ssh-'+id()),file=openSync(temporary,'wx',0o600);
  try{writeFileSync(file,value);fsyncSync(file);}finally{closeSync(file);}renameSync(temporary,path);
 }
 prepare(input:any,previous?:SSHConnection) {
  const value={...previous,...input};
  if(input?.privateKey!==undefined){
   if(typeof input.privateKey!=='string'||Buffer.byteLength(input.privateKey)>1024*1024||!/^-----BEGIN .*PRIVATE KEY-----/.test(input.privateKey))throw new HttpError(400,'请选择有效的 SSH 私钥');
   const parsed=utils.parseKey(input.privateKey,input.passphrase);if(parsed instanceof Error&&!/encrypted|passphrase/i.test(parsed.message))throw new HttpError(400,'SSH 私钥格式无效');
   value.identityFile='ssh-key-'+id();this.atomic(join(this.store.home,'secrets',value.identityFile),input.privateKey);
  }
  const secret=value.authMethod==='password'?input?.password:input?.passphrase;
  if(secret!==undefined&&secret!==''){
   if(typeof secret!=='string'||secret.length>4096||/[\0\r\n]/.test(secret))throw new HttpError(400,'SSH 密码或口令格式无效');
   value.credentialRef='ssh-secret-'+id();this.atomic(join(this.store.home,'secrets',value.credentialRef),secret);this.secrets.add(secret);
  }
  return this.configuration(value);
 }
 revision(resource:Resource) {
  const config=this.configuration(resource.ssh),files=[config.identityFile,config.credentialRef].filter(Boolean).map(value=>{const info=lstatSync(this.privateFile(value!));return [info.ino,info.size,info.mtimeMs,info.ctimeMs];});
  return digest([resource.id,resource.projectId,config,files,this.store.get('resourceRevisions',resource.id)??1]);
 }
 prompt(session:string){return this.prompts.get(session)?.public??null;}
 revalidate(resource:Resource,revision:string,peer?:string){if(this.revision(resource)!==revision||peer&&!this.pins(this.configuration(resource.ssh)).some(pin=>fingerprint(pin.key)===peer))throw new HttpError(409,'SSH 连接配置、凭据或已验证的服务器身份已变化');}
 private pinPath(config:SSHConnection){return join(this.store.home,'secrets','ssh-host-'+createHash('sha256').update(canonicalHost(config.host)+':'+config.port).digest('hex')+'.known_hosts');}
 private pinText(config:SSHConnection){const path=this.pinPath(config);return existsSync(path)?readFileSync(this.privateFile(path),'utf8'):'';}
 private pins(config:SSHConnection) {
  const host=canonicalHost(config.host),peer=config.port===22?host:`[${host}]:${config.port}`;
  return this.pinText(config).split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>{
   const [hosts,algorithm,encoded,...rest]=line.trim().split(/\s+/);
   const matches=hosts.split(',').some(pattern=>{
    if(pattern===peer)return true;
    if(pattern.startsWith('|1|')){const [,version,salt,hash]=pattern.split('|');try{const actual=createHmac('sha1',Buffer.from(salt,'base64')).update(peer).digest(),expected=Buffer.from(hash,'base64');return version==='1'&&actual.length===expected.length&&timingSafeEqual(actual,expected);}catch{return false;}}
    return false;
   });
   if(!matches||!algorithm||!encoded||hosts.startsWith('@')||!utils.parseKey(`${algorithm} ${encoded}`)||utils.parseKey(`${algorithm} ${encoded}`) instanceof Error)throw new HttpError(409,'SSH 主机信任记录需核实');
   return {algorithm,key:Buffer.from(encoded,'base64')};
  });
 }
 private authorize(session:string,resource:Resource,key:Buffer,signal:AbortSignal):Promise<boolean> {
  const config=this.configuration(resource.ssh),pins=this.pins(config);
  if(pins.some(pin=>pin.key.equals(key)))return Promise.resolve(true);
  if(this.prompts.has(session))throw new HttpError(409,'请先处理本会话现有 SSH 指纹确认');
  const parsed=utils.parseKey(key);if(parsed instanceof Error||Array.isArray(parsed))throw new HttpError(409,'SSH 主机公钥无效');
  return new Promise<boolean>((resolve,reject)=>{
   const finish=(accepted:boolean,error?:Error)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);this.prompts.delete(session);this.notify(session);error?reject(error):resolve(accepted);};
   const abort=()=>finish(false,new HttpError(409,'SSH 连接已取消'));
   const timer=setTimeout(()=>finish(false,new HttpError(409,'SSH 指纹确认已超时，请重新连接')),120000);
   const prompt:Prompt={resourceId:resource.id,revision:this.revision(resource),pinHash:digest(this.pinText(config)),key,
    public:{id:id(),resourceId:resource.id,host:config.host,port:config.port,algorithm:parsed.type,fingerprint:fingerprint(key),previousFingerprints:pins.map(pin=>fingerprint(pin.key)),changed:pins.length>0,scope:'lake'},resolve:accept=>finish(accept)};
   this.prompts.set(session,prompt);signal.addEventListener('abort',abort,{once:true});this.notify(session);if(signal.aborted)abort();
  });
 }
 decide(session:string,data:Record<string,any>) {
  const prompt=this.prompts.get(session);
  if(!prompt||prompt.public.id!==data.id||prompt.public.fingerprint!==data.fingerprint||typeof data.accept!=='boolean')throw new HttpError(409,'SSH 指纹确认已失效');
  if(!data.accept){prompt.resolve(false);return {accepted:false};}this.security.check();
  const resource=this.store.require<Resource>('resources',prompt.resourceId),config=this.configuration(resource.ssh);
  if(this.store.session(session).projectId!==resource.projectId||prompt.revision!==this.revision(resource)||prompt.pinHash!==digest(this.pinText(config)))throw new HttpError(409,'SSH 配置或信任记录已变化，请重新连接');
  if(data.accept){const host=canonicalHost(config.host),peer=config.port===22?host:`[${host}]:${config.port}`;this.atomic(this.pinPath(config),`${peer} ${prompt.public.algorithm} ${prompt.key.toString('base64')}\n`);}
  prompt.resolve(data.accept);return {accepted:data.accept};
 }
 scrub(value:string,live=false) {
  let keep=0;
  for(const secret of this.secrets){if(live)for(let n=1;n<secret.length&&n<=value.length;n++)if(value.endsWith(secret.slice(0,n)))keep=Math.max(keep,n);value=value.split(secret).join('[REDACTED]');}
  return this.redact(keep?value.slice(0,-keep):value)+(keep?'[REDACTED]':'');
 }
 private error(error:any){
  if(error instanceof HttpError)return error;
  if(error?.level==='client-authentication')return new HttpError(403,'SSH 身份认证失败，请核对已保存的用户名、私钥或密码');
  if(['ENOTFOUND','EAI_AGAIN'].includes(error?.code))return new HttpError(502,'SSH 主机地址无法解析');
  if(error?.code==='ECONNREFUSED')return new HttpError(502,'SSH 端口拒绝连接');
  if(error?.code==='ETIMEDOUT'||error?.level==='client-timeout')return new HttpError(504,'SSH 连接或身份认证超时');
  return new HttpError(502,'SSH 连接中断，未取得完整结果');
 }
 async connect(session:string,resource:Resource,signal:AbortSignal):Promise<Client> {
  this.security.check();if(this.closed||signal.aborted)throw new HttpError(409,'SSH 连接已取消');
  if(resource.kind!=='ssh'||resource.projectId!==this.store.session(session).projectId||resource.status!=='available')throw new HttpError(403,'SSH 资源不在本项目或连接配置不可用');
  const config=this.configuration(resource.ssh),revision=this.revision(resource),pins=this.pins(config),secret=config.credentialRef?readFileSync(this.privateFile(config.credentialRef,4096),'utf8'):undefined;
  if(secret){if(/[\0\r\n]/.test(secret))throw new HttpError(409,'SSH 密码或口令文件无效');this.secrets.add(secret);this.registerSecret?.(secret);}
  const conn=new Client();this.clients.add(conn);
  return new Promise<Client>((resolve,reject)=>{
   let ready=false,ended=false,peer='';
   const handshake=new AbortController(),verificationSignal=AbortSignal.any([signal,handshake.signal]);
   let timer:ReturnType<typeof setTimeout>;
   const fail=(error:unknown)=>{if(ended)return;ended=true;handshake.abort();clearTimeout(timer);signal.removeEventListener('abort',abort);conn.destroy();this.clients.delete(conn);reject(this.error(error));};
   const abort=()=>{if(ready)conn.destroy();else fail(new HttpError(409,'SSH 连接已取消'));};
   timer=setTimeout(()=>fail(new HttpError(504,'SSH 网络连接超时')),10000);
   signal.addEventListener('abort',abort,{once:true});
   conn.on('error',error=>{if(!ready)fail(error);});
   conn.on('close',()=>{this.clients.delete(conn);signal.removeEventListener('abort',abort);if(!ready)fail(new HttpError(502,'SSH 在认证完成前断开'));});
   conn.once('ready',()=>{try{this.security.check();if(signal.aborted||this.revision(this.store.require<Resource>('resources',resource.id))!==revision)throw new HttpError(409,'SSH 配置已变化');clearTimeout(timer);ready=true;this.peerKeys.set(conn,peer);resolve(conn);}catch(error){fail(error);}});
   const algorithms=pins.length?{serverHostKey:[...new Set(pins.flatMap(pin=>pin.algorithm==='ssh-rsa'?['rsa-sha2-512','rsa-sha2-256','ssh-rsa']:[pin.algorithm]))] as any}:undefined;
   const privateKey=config.authMethod==='key'?readFileSync(this.privateFile(config.identityFile!)):undefined;
   if(privateKey){this.secrets.add(privateKey.toString('utf8'));this.registerSecret?.(privateKey.toString('utf8'));}
   conn.connect({host:config.host,port:config.port,username:config.username,readyTimeout:135000,keepaliveInterval:15000,keepaliveCountMax:2,algorithms,
    authHandler:config.authMethod==='password'?['password']:['publickey'],password:config.authMethod==='password'?secret:undefined,
    privateKey,passphrase:config.authMethod==='key'?secret:undefined,
    hostVerifier:(key:Buffer,callback:(accepted:boolean)=>void)=>{clearTimeout(timer);void Promise.resolve().then(()=>this.authorize(session,resource,key,verificationSignal)).then(accepted=>{
     if(!accepted){fail(new HttpError(403,'已取消 SSH 服务器指纹确认'));callback(false);return;}
     if(signal.aborted||this.revision(this.store.require<Resource>('resources',resource.id))!==revision){fail(new HttpError(409,'SSH 配置已变化'));callback(false);return;}
     this.security.check();peer=fingerprint(key);timer=setTimeout(()=>fail(new HttpError(504,'SSH 身份认证超时')),15000);callback(true);
    }).catch(error=>{fail(error);callback(false);});},
   });
  });
 }
 terminal(session:string,resource:Resource,command:string):TerminalDevice {
  const events=new EventEmitter(),controller=new AbortController(),decoder=new StringDecoder('utf8');let channel:ClientChannel|undefined,conn:Client|undefined,ended=false,lastError:string|undefined;
  const finish=(code=0)=>{if(ended)return;ended=true;const last=decoder.end();if(last)events.emit('data',last);events.emit('exit',{exitCode:code});conn?.end();};
  void this.connect(session,resource,controller.signal).then(client=>{conn=client;let code=0;
   client.exec(command,{pty:{term:'xterm-256color',cols:100,rows:30,width:0,height:0}},(error,stream)=>{
    if(error){lastError='SSH 无法启动远程 Shell';finish(1);return;}channel=stream;
    stream.on('data',(value:Buffer)=>events.emit('data',decoder.write(value)));stream.stderr.on('data',(value:Buffer)=>events.emit('data',decoder.write(value)));
    stream.on('exit',(value:number)=>{code=Number.isInteger(value)?value:1;});stream.once('close',()=>finish(code));stream.once('error',()=>finish(1));
   });client.once('close',()=>finish(1));
  }).catch(error=>{if(!ended){lastError=this.error(error).message;finish(1);}});
  return {get error(){return lastError;},write:data=>{if(!channel||ended)throw new HttpError(409,'SSH 终端尚未就绪');channel.write(data);},resize:(cols,rows)=>channel?.setWindow(rows,cols,0,0),
   kill:()=>{controller.abort();channel?.close();conn?.destroy();finish(1);},onData:callback=>events.on('data',callback),onExit:callback=>events.once('exit',callback)};
 }
 async inspect(session:string,resource:Resource,metric:string,signal:AbortSignal,guard:()=>void,processDirectory?:unknown,networkInput?:unknown) {
  const network=networkProbe(metric,networkInput);
  if(networkInput!==undefined && !network) throw new HttpError(400,"网络参数只适用于网络诊断");
  if(!network && !Object.hasOwn(profiles,metric))throw new HttpError(400,'不支持的主机读取指标');
  if(processDirectory!==undefined && metric!=='processes') throw new HttpError(400,'进程目录只适用于 processes');
  const scoped=processDirectory===undefined ? undefined : directoryProcessSample(processDirectory);
  const profile=metric as keyof typeof profiles,revision=this.revision(resource),conn=await this.connect(session,resource,signal);
  try{return await new Promise((resolve,reject)=>{
   let channel:ClientChannel|undefined,output=Buffer.alloc(0),done=false;const timer=setTimeout(()=>finish(new HttpError(504,'SSH 只读检查超时')),network?27000:20000);
   const finish=(error?:unknown,result?:unknown)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);channel?.close();error?reject(error):resolve(result);};
   const abort=()=>finish(new HttpError(409,'SSH 只读检查已取消'));signal.addEventListener('abort',abort,{once:true});
   try{guard();if(signal.aborted||this.revision(this.store.require<Resource>('resources',resource.id))!==revision)throw new HttpError(409,'SSH 连接配置或任务资格已变化');}
   catch(error){finish(error);return;}
   const shell='/usr/bin/env -i PATH=/usr/bin:/bin LC_ALL=C /bin/sh -c ';
   const command=network ? shell+quote(networkProbeShell)+' lake-network-probe '+quote(networkProbeProgram)+' '+quote(JSON.stringify(network))
     : shell+quote(scoped?.script ?? profiles[profile])+(scoped?' lake-process-sample '+quote(scoped.directory):'');
   conn.exec(command,(error,stream)=>{if(error){finish(new HttpError(502,'SSH 只读命令未启动'));return;}channel=stream;let code:number|undefined;
    const collect=(data:Buffer)=>{if(output.length+data.length>131072){finish(new HttpError(502,'SSH 只读结果超过上限'));return;}output=Buffer.concat([output,data]);};
    stream.on('data',collect);stream.stderr.on('data',collect);stream.on('exit',(value:number)=>{code=value;});
    stream.once('close',()=>code===0?finish(undefined,{command:network?'inspect_host '+JSON.stringify(network):command,resourceId:resource.id,metric,profileId:scoped?'lake.host.directory-processes':'lake.host.'+profile,profileVersion:1,configurationRevision:revision,hostFingerprint:this.peerKeys.get(conn),exitCode:code,output:this.scrub(output.toString('utf8')),observedAt:new Date().toISOString()}):finish(new HttpError(502,'SSH 只读检查未取得成功退出回执')));
    stream.once('error',()=>finish(new HttpError(502,'SSH 只读检查连接中断')));
   });conn.once('close',()=>finish(new HttpError(502,'SSH 连接中断，读取结果未确认')));
  });}finally{conn.end();}
 }
 async close(){this.closed=true;for(const prompt of this.prompts.values())prompt.resolve(false);for(const client of this.clients)client.destroy();this.clients.clear();}
}
