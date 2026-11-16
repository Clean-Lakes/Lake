#!/usr/bin/env node
// Signed Lake Dev, actual Pilot/Workers, disposable data and a loopback model.
// Send texts.B and texts.C through the visible composer after ready=true.
// POST controlOrigin/complete releases all held invocations, including followups.
// Quit the isolated Dev through its normal stop menu after validation.
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const http=require('node:http'),{spawn}=require('node:child_process');
const texts={
 setup:'创建水獭核对专员和猫头鹰资料专员，使用 Lake 原生 Agent，仅处理本地虚构样例，不连接业务资源。[PILOT_CONTINUOUS:setup]',
 A:'请水獭核对专员处理样例 A，保留进展等待补充。[PILOT_CONTINUOUS:A]',
 B:'让同一位水獭核对专员另做独立样例 B，原任务 A 继续。[PILOT_CONTINUOUS:B]',
 C:'给原任务 A 补充日志核对要求；再让水獭和猫头鹰两位专员共同整理另一份样例 C。[PILOT_CONTINUOUS:C]',
};
const key='synthetic-pilot-continuous-dev-key';
const content=m=>typeof m.content==='string'?m.content:(m.content??[]).map(p=>p.text??'').join('');
const tool=(name,args,index=0)=>({index,id:'continuous-'+name+'-'+index,type:'function',function:{name,arguments:JSON.stringify(args)}});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(read,check,label){for(const end=Date.now()+45000;Date.now()<end;){const value=await read();if(check(value))return value;await sleep(100);}throw Error(label);}
let home,data,metadata,origin,controlOrigin,nativePid,projectId,routerSessionId,buildOrigin,api;
let ready=false,completing=false,workspace={workers:[],channels:[]},timer,closed=false;
const held=new Set(),requests=[],roles=new Map();
let metadataWrites=Promise.resolve();
function status(){return {ready,completing,home,data,origin,controlOrigin,nativePid,projectId,routerSessionId,buildOrigin,texts,
 workers:workspace.workers.map(w=>({id:w.id,roleId:w.roleId,roleName:w.roleName,sessionId:w.sessionId,assignmentState:w.assignmentState,task:w.task})),
 requests,held:held.size};}
function save(){
 if(!metadata)return Promise.resolve();
 const payload=JSON.stringify(status(),null,2)+'\n';
 metadataWrites=metadataWrites.then(async()=>{const temporary=metadata+'.next';await fs.writeFile(temporary,payload,{mode:0o600});await fs.rename(temporary,metadata);});
 return metadataWrites;
}
async function refresh(){
 workspace=await api(`/api/projects/${projectId}/superagent`);
 for(const channel of workspace.channels??[])roles.set(channel.roleName,channel.roleId);
 await save();return workspace;
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
function chunk(res,delta,finish=null){if(!res.destroyed&&!res.writableEnded)res.write('data: '+JSON.stringify({id:'continuous',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:finish}]})+'\n\n');}
function end(res,delta){chunk(res,delta);chunk(res,{},delta.tool_calls?'tool_calls':'stop');res.end('data: [DONE]\n\n');}
function release(entry){
 if(entry.released||entry.res.destroyed||entry.res.writableEnded)return;
 entry.released=true;
 const extra=entry.context.followups?.length?'已包含原任务收到的补充要求，':'';
 end(entry.res,{tool_calls:[tool('work_finish',{outcome:'completed',summary:`${entry.tag} 的本地样例核对${extra}已完成；未访问业务资源。`})]});
}
function currentAssignment(messages){
 for(let i=messages.length-1;i>=0;i--){if(messages[i].role!=='user')continue;try{const value=JSON.parse(content(messages[i]));if(value.assignment?.workerId)return {value,index:i};}catch{}}
 throw Error('missing controlled worker assignment');
}
function routerReply(messages){
 const start=messages.findLastIndex(m=>m.role==='user'&&content(m).startsWith('[LAKE ADMITTED HUMAN EVENTS'));
 if(start<0)throw Error('missing admitted input');
 const events=JSON.parse(content(messages[start]).split('\n')[1]);
 if(events.length!==1)throw Error('independent inputs were combined');
 const event=events[0],tag=event.text.match(/\[PILOT_CONTINUOUS:(\w+)\]/)?.[1];
 const calls=messages.slice(start+1).flatMap(m=>m.tool_calls??[]);
 if(calls.some(call=>{try{return JSON.parse(call.function.arguments).event_id===event.id;}catch{return false;}}))return {content:`${tag} 已安排。`};
 requests.push({kind:'router',eventId:event.id,text:event.text,tag});
 const common={event_id:event.id,quote:event.text,reason:'本地持续接单验收'};
 if(tag==='setup')return {tool_calls:[
  tool('manage_specialist',{event_id:event.id,quote:event.text,part_key:'otter',action:'create',role_key:'continuous-otter',name:'水獭核对专员',duties:'核对本地虚构样例',avatar_id:'otter',execution:{kind:'native'}}),
  tool('manage_specialist',{event_id:event.id,quote:event.text,part_key:'owl',action:'create',role_key:'continuous-owl',name:'猫头鹰资料专员',duties:'整理本地虚构资料',avatar_id:'owl',execution:{kind:'native'}},1),
 ]};
 const otter=roles.get('水獭核对专员'),owl=roles.get('猫头鹰资料专员');
 if(!otter||!owl)throw Error('specialists not ready');
 if(tag==='A'||tag==='B')return {tool_calls:[tool('route_work',{...common,part_key:tag,action:'create',role_id:otter,title:`独立样例 ${tag} [PILOT_CONTINUOUS:${tag}]`})]};
 if(tag==='C'){
  const a=workspace.workers.find(w=>w.task.title.includes('[PILOT_CONTINUOUS:A]'));
  if(!a)throw Error('original task A unavailable');
  return {tool_calls:[
   tool('route_work',{...common,quote:'给原任务 A 补充日志核对要求',part_key:'supplement-A',action:'followup',task_id:a.task.taskId,role_id:otter}),
   tool('route_work',{...common,quote:'再让水獭和猫头鹰两位专员共同整理另一份样例 C',part_key:'new-C',action:'create',role_ids:[otter,owl],title:'共同样例 C [PILOT_CONTINUOUS:C]',role_instructions:[{role_id:otter,instruction:'核对 C 的样例记录'},{role_id:owl,instruction:'整理 C 的样例资料'}]},1),
  ]};
 }
 throw Error('unexpected controlled input');
}
async function model(req,res){
 if(req.headers.authorization!=='Bearer '+key)return json(res,401,{error:'fixture authorization rejected'});
 const chunks=[];let size=0;for await(const part of req){size+=part.length;if(size>8*1024*1024)return json(res,413,{error:'request too large'});chunks.push(part);}
 const request=JSON.parse(Buffer.concat(chunks).toString()),messages=request.messages??[],tools=request.tools??[];
 res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache'});
 if(tools.some(t=>t.function?.name==='route_work')){end(res,routerReply(messages));await save();return;}
 if(!tools.some(t=>t.function?.name==='work_finish')){end(res,{content:'隔离本地样例。'});return;}
 const {value:context,index}=currentAssignment(messages);
 const tag=context.goal.title.match(/\[PILOT_CONTINUOUS:(\w+)\]/)?.[1];
 if(!tag)throw Error('missing controlled task tag');
 if(messages.slice(index+1).some(m=>m.tool_calls?.some(call=>call.function?.name==='work_finish'))){end(res,{content:`${tag} 的本轮记录已提交。`});return;}
 requests.push({kind:'worker',tag,assignment:context.assignment,followups:context.followups??[]});
 const entry={res,context,tag,released:false};held.add(entry);
 const heartbeat=setInterval(()=>{if(!res.destroyed&&!res.writableEnded)res.write(': isolated continuous input\n\n');},10000);
 res.once('close',()=>{clearInterval(heartbeat);held.delete(entry);void save();});
 chunk(res,{role:'assistant',reasoning_content:`${tag} 的合成思考记录：核对本地虚构样例，保留准确任务来源。`});
 chunk(res,{content:`正在核对样例 ${tag}，${context.followups?.length?'已收到原任务补充，继续处理。':'等待后续要求。'}\n\n`+
  '这是隔离验收的虚构公开进度，只用于检查持续接单、专员身份与任务归属；不会访问业务主机、数据库、凭据或外部服务。'.repeat(3)});
 if(completing)release(entry);
 await save();
}
async function main(){
 if(process.platform!=='darwin')throw Error('macOS is required');
 home=await fs.mkdtemp(path.join(os.tmpdir(),'lake-pilot-continuous-dev-'));await fs.chmod(home,0o700);data=path.join(home,'web-data');
 metadata=path.resolve(process.argv[2]??path.join(home,'verification.json'));
 const owned=await fs.open(metadata,'wx',0o600);await owned.close();
 const app=path.join(os.homedir(),'Applications/Lake Dev.app');
 const build=JSON.parse(await fs.readFile(path.join(app,'Contents/Resources/build-origin.json'),'utf8'));
 buildOrigin=Object.fromEntries(['gitHead','gitBranch','version','dirty','backendRuntime'].map(k=>[k,build[k]]));
 const provider=http.createServer((req,res)=>void(async()=>{
  const url=new URL(req.url,controlOrigin);
  if(req.headers.origin&&req.headers.origin!==controlOrigin)return json(res,403,{error:'origin rejected'});
  if(req.headers.host!==new URL(controlOrigin).host)return json(res,403,{error:'host rejected'});
  if(url.pathname==='/v1/chat/completions'&&req.method==='POST')return model(req,res);
  if(url.pathname==='/status'&&req.method==='GET')return json(res,200,status());
  if(url.pathname==='/complete'&&req.method==='POST'&&ready){completing=true;for(const entry of held)release(entry);await save();return json(res,202,{completing:true});}
  json(res,404,{error:'unknown fixture control'});
 })().catch(()=>{if(!res.headersSent)json(res,500,{error:'controlled fixture failed'});else res.end();console.error('Controlled fixture failed; no request or credential contents logged.');}));
 await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));controlOrigin='http://127.0.0.1:'+provider.address().port;
 const log=await fs.open(path.join(home,'native.log'),'wx',0o600),env={...process.env};
 for(const field of ['LAKE_HOME','LAKE_WEB_DATA_DIR','LAKE_WEB_TOKEN','LAKE_DEV_HOME','LAKE_DEV_WEB_DATA_DIR','LAKE_DEV_WEB_TOKEN'])delete env[field];
 const native=spawn(path.join(app,'Contents/MacOS/Lake'),['--lake-home',home,'--lake-data',data],{env,stdio:['ignore',log.fd,log.fd]});await log.close();nativePid=native.pid;
 native.once('exit',()=>{closed=true;clearInterval(timer);provider.close();provider.closeAllConnections();void save();});
 const runtime=await until(async()=>{if(closed)throw Error('isolated Dev exited');try{return JSON.parse(await fs.readFile(path.join(data,'runtime.json'),'utf8'));}catch{return null;}},r=>r?.origin&&r?.token,'isolated runtime did not start');
 const endpoint=new URL(runtime.origin);if(endpoint.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname))throw Error('non-loopback runtime');origin=endpoint.origin;
 api=async(route,method='GET',body)=>{const response=await fetch(origin+route,{method,headers:{Authorization:'Bearer '+runtime.token,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!response.ok)throw Error('isolated API rejected');return response.json();};
 await api('/api/settings/model','PUT',{url:controlOrigin+'/v1/chat/completions',name:'continuous-input-fixture',apiKey:key});
 const project=await api('/api/projects','POST',{name:'Pilot 持续接单 · 隔离验收'});projectId=project.id;
 routerSessionId=(await api(`/api/projects/${projectId}/superagent`,'POST',{})).routerSessionId;
 await api(`/api/sessions/${routerSessionId}/messages`,'POST',{text:texts.setup});
 await until(refresh,()=>roles.size===2,'specialists not created');
 await until(()=>api(`/api/sessions/${routerSessionId}/snapshot`),s=>s.ai?.status==='completed','setup did not settle');
 await api(`/api/sessions/${routerSessionId}/messages`,'POST',{text:texts.A});
 await until(refresh,()=>requests.some(r=>r.kind==='worker'&&r.tag==='A'),'task A did not start');
 ready=true;await save();timer=setInterval(()=>{if(!closed)void refresh().catch(()=>{});},500);
 console.log(JSON.stringify({ready:true,metadata,origin,controlOrigin,nativePid,buildOrigin,texts}));
}
main().catch(error=>{console.error(JSON.stringify({error:'Continuous Pilot fixture failed',metadata,nativePid}));process.exitCode=1;});
