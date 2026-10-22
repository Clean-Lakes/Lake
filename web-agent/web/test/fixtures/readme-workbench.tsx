// README capture: the real application with fictional, read-only in-memory API responses.
// No backend, credentials, remote resources, model calls or resource operations.
import {createRoot} from 'react-dom/client';
import App from '../../src/App';
import {WindowsChrome} from '../../src/WindowsChrome';
import {setThemePreference} from '../../src/appearance';
import type {Resource,WorkSession,SessionSnapshot,SRETask} from '../../../shared/contracts';
import '../../src/theme.css';
import '../../src/appSelect.css';
import '../../src/providerIcon.css';
import '../../src/composerModelSelect.css';
import '../../src/composerCompletion.css';
import '../../src/agentQuestion.css';
import '../../src/sreCollaboration.css';
const dark=new URLSearchParams(location.search).get('theme')==='dark';
setThemePreference(dark?'dark':'light');
const at=(minute:number)=>`2026-10-16T02:${String(minute).padStart(2,'0')}:00Z`;
const project={id:'demo-project',name:'Northwind · 生产环境',createdAt:at(0)};
const resources=[
 ['order-api','订单服务 · order-api','ssh','订单服务应用节点'],
 ['gateway','网关 · edge-01','ssh','入口网关'],
 ['postgres','订单数据库 · PostgreSQL','database','订单数据'],
 ['redis','缓存 · Redis','redis','会话与热点缓存'],
 ['docker','容器 · app-01','docker','应用容器'],
].map(([id,name,kind,description])=>({id,projectId:project.id,name,kind,description,status:'available'})) as Resource[];
if(new URLSearchParams(location.search).has('mention-types')){
 resources.forEach(resource=>{resource.name=resource.id==='postgres'?'192.0.2.141-pg':'192.0.2.141';});
 resources.find(resource=>resource.id==='gateway')!.kind='local';
}
if(new URLSearchParams(location.search).has('scrollbar'))resources.push(...Array.from({length:30},(_,i)=>({id:`demo-host-${i}`,projectId:project.id,name:`演示主机 ${i+1}`,kind:'ssh' as const,description:'滚动条验证用虚构资源',status:'available' as const})));
const sessions=['订单服务发布回滚','网关延迟排查','数据库连接数巡检'].map((title,i)=>({id:`demo-session-${i}`,projectId:project.id,title,status:'completed',resourceIds:resources.map(r=>r.id),createdAt:at(0),updatedAt:at(30-i),icon:'chat',tags:[]})) as WorkSession[];
if(new URLSearchParams(location.search).has('sidebar-backgrounds'))sessions.push(...Array.from({length:13},(_,i)=>({...sessions[0]!,id:`extra-session-${i}`,title:`演示会话 ${i+4}`,updatedAt:at(10)})));
const session=sessions[0]!;
const tree=[{id:'apps',projectId:project.id,parentId:null,kind:'folder',name:'应用服务',resourceId:null,position:0},{id:'data',projectId:project.id,parentId:null,kind:'folder',name:'数据服务',resourceId:null,position:1},...resources.map((r,i)=>({id:'node-'+r.id,projectId:project.id,parentId:['postgres','redis'].includes(r.id)?'data':'apps',kind:'resource',name:r.name,resourceId:r.id,position:i}))];
const steps=[
 {id:'observe',role:'investigator',kind:'observe',description:'核对发布变更与异常日志'},
 {id:'rollback',role:'executor',kind:'act',description:'按已批准的方案回滚订单服务'},
 {id:'verify',role:'verifier',kind:'verify',description:'独立验证错误率与关键请求'},
 {id:'summary',role:'coordinator',kind:'summarize',description:'汇总恢复结果与后续建议'},
].map((s,i)=>({...s,resourceIds:['order-api'],dependsOn:i?[['observe','rollback','verify'][i-1]]:[],completionChecks:['核对实际结果']}));
const messages=[
 {id:'plan',roleId:'coordinator',kind:'finding',body:'计划已确认。调查员核对变更，执行员完成回滚，验证员独立验收。',minute:24},
 {id:'observed',roleId:'investigator',kind:'finding',step:'observe',body:'异常集中在新版本的上游连接超时，旧版本节点未出现相同错误。',minute:25},
 {id:'rolled-back',roleId:'executor',kind:'result',step:'rollback',body:'已按批准的方案完成回滚：v2.8.1 → v2.8.0。三个实例均已就绪。',minute:26},
 {id:'verified',roleId:'verifier',kind:'verification',step:'verify',body:'关键请求验证通过；错误率由 3.8% 降至 0.06%，复测未再出现上游超时。',minute:28},
 {id:'finished',roleId:'coordinator',kind:'summary',step:'summary',body:'服务已恢复，回滚效果已独立验证。建议保留异常样本，排查新版本的连接超时后再发布。',minute:29},
].map((m,i)=>({...m,sessionId:session.id,taskId:'demo-task',revision:1,sequence:i+1,createdAt:at(m.minute),...(m.step?{attemptId:m.step,roleRunId:'role-'+m.step}:{})}));
const task={id:'demo-task',sessionId:session.id,projectId:project.id,requestId:'demo-request',goal:'回滚订单服务并验证恢复',scope:['order-api'],mode:'assist',status:'completed',outcome:'completed',recoveryStatus:'verified',rootCauseStatus:'unknown',profileId:'lake-sre',profileVersion:1,revision:1,tokenBudget:128000,budgetSpent:0,usage:{input:0,output:0,total:0},createdAt:at(24),updatedAt:at(29),plans:[{id:'plan-v1',version:1,goal:'回滚订单服务并验证恢复',taskType:'recovery',scope:['order-api'],collaborationVersion:1,steps}],runs:[{id:'plan-run',planRevisionId:'plan-v1',status:'completed'}],attempts:steps.map((s,i)=>({id:s.id,stepId:s.id,planRunId:'plan-run',roleRunId:'role-'+s.id,status:'succeeded',evidence:[],operations:[],startedAt:at(25+i),finishedAt:at(26+i)})),messages,verifications:[]} as unknown as SRETask;
const snapshot={session,resources,resourceTree:tree,messages:[{id:'demo-question',sessionId:session.id,role:'user',text:'订单服务发布后错误率升高，按已批准的方案回滚，并验证是否恢复。',createdAt:at(23)}],specialists:[],evidence:[],actions:[],terminals:[],cursor:1,replyTimings:[{messageId:'demo-question',startedAt:at(24),finishedAt:at(29),status:'completed'}],messageQueue:{paused:false,revision:0,lastError:'',items:[]},ai:{session:session.id,profile:'core',status:'completed',rootTurnId:'demo-turn',turns:1,turnStartedAt:at(24),turnFinishedAt:at(29),cards:[],cardsOffset:0,totalCards:0,agentRuns:steps.map((s,i)=>({id:'role-'+s.id,sessionId:session.id,rootTurnId:'demo-turn',sreTaskId:task.id,sreRole:s.role,role:s.role,task:s.description,resourceIds:['order-api'],status:'completed',createdAt:at(25+i),startedAt:at(25+i),finishedAt:at(26+i),toolCount:3})),usage:{known:true,input:17820,output:1240,total:19060}},sre:{enabled:true,tasks:[task]}} as unknown as SessionSnapshot;
const model={id:'demo-model',providerId:'demo-provider',providerName:'DeepSeek',modelId:'deepseek-chat',name:'DeepSeek',displayName:'DeepSeek',protocol:'openai'};
const catalog={projects:[project],sessions,resources,resourceTree:tree,tags:[],terminals:[]};
const bootstrap={authenticated:true,modelConfigured:true,modelName:'DeepSeek',modelId:model.modelId,modelSelection:model,terminalMode:'pty',supportsImageInput:false,aiRuntime:'go'};
if(new URLSearchParams(location.search).has('conversation-radii')){
 const resource=resources.find(value=>value.id==='postgres')!;
 const label='@'+resource.name;
 snapshot.messages=[{id:'demo-question',sessionId:session.id,role:'user',text:label+' 帮我核对归档命令。',mentions:[{kind:'resource',id:resource.id,label,start:0,end:label.length,resourceKind:resource.kind}],createdAt:at(23)}];
 snapshot.sre={enabled:false,tasks:[]};snapshot.ai!.agentRuns=[];
 const command='cd /d E:\\example && "C:\\Program Files\\7-Zip\\7z.exe" a -t7z -mx=0 -ms=off -mmt=12 "E:\\example-all.7z" *';
 snapshot.ai!.cards=[{id:'radii-reply',type:'message',status:'completed',at:at(29),content:'可以整目录归档，命令如下：\n\n```bat\n'+command+'\n```\n\n完成后检查归档完整性：\n\n```bat\n7z t E:\\example-all.7z\n```\n\n长命令可以横向滚动，右侧按钮复制完整内容。'}];
 snapshot.ai!.cardsOffset=0;snapshot.ai!.totalCards=1;
}
if(new URLSearchParams(location.search).has('glass-header')){
 snapshot.ai!.cards=[{id:'glass-reply',type:'message',status:'completed',at:at(29),content:Array.from({length:24},(_,i)=>`第 ${i+1} 项演示检查：服务正常，原始记录保留。\n\n只有标题下方的内容透过玻璃模糊，标题文字保持清晰。`).join('\n\n')}];
 snapshot.ai!.cardsOffset=0;snapshot.ai!.totalCards=1;
}
if(new URLSearchParams(location.search).has('resource-label-colors')){
 const requests=['检查服务状态','查看本机资源','查询数据库','检查缓存','查看容器'];
 snapshot.messages=resources.map((resource,index)=>{const label='@'+resource.name;return {id:'label-'+resource.id,sessionId:session.id,role:'user',text:label+' '+requests[index],mentions:[{kind:'resource',id:resource.id,label,start:0,end:label.length,resourceKind:resource.kind}],createdAt:at(23+index)};});
 snapshot.sre={enabled:false,tasks:[]};snapshot.ai!.agentRuns=[];snapshot.ai!.cards=[];snapshot.ai!.cardsOffset=0;snapshot.ai!.totalCards=0;snapshot.replyTimings=[];
}
if(new URLSearchParams(location.search).has('image-messages')){
 const picture=(id:string,width:number,height:number,color:string)=>({id,name:id+'.svg',width,height,mimeType:'image/svg+xml',base64:'',sizeBytes:0,url:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/><circle cx="${width*.72}" cy="${height*.25}" r="${Math.min(width,height)*.12}" fill="#dceadf"/><path d="M0 ${height*.85} L${width*.4} ${height*.35} L${width} ${height*.9} V${height} H0Z" fill="#55766c"/><text x="${width*.08}" y="${height*.17}" fill="white" font-family="sans-serif" font-size="${Math.min(width,height)*.07}">${width} × ${height}</text></svg>`)});
 snapshot.messages=[
  {id:'image-user-1',sessionId:session.id,role:'user',text:'这两张图帮我看一下',images:[picture('横图',1800,1200,'#789b92'),picture('竖图',900,2400,'#7f8eac')],createdAt:at(31)},
  {id:'image-user-2',sessionId:session.id,role:'user',text:'',images:[picture('小图',48,48,'#8a9b72')],createdAt:at(32)},
  {id:'text-user',sessionId:session.id,role:'user',text:'普通文字仍保留原来的气泡。',createdAt:at(33)},
 ];
 snapshot.ai!.cards=[];snapshot.ai!.agentRuns=[];snapshot.sre={enabled:false,tasks:[]};snapshot.replyTimings=[];
}
const sentTagsProof=new URLSearchParams(location.search).has('sent-tags');
if(sentTagsProof){
 snapshot.messages=[{id:'legacy-tags',sessionId:session.id,role:'user',text:'@订单服务 · order-api和@网关 · edge-01检查状态',createdAt:at(31)},{id:'plain-tags',sessionId:session.id,role:'user',text:'字面文字 @订单服务 · order-api',mentions:[],createdAt:at(32)}];
 snapshot.ai!.agentRuns=[];snapshot.sre={enabled:false,tasks:[]};snapshot.replyTimings=[];
}
const referenceProof=new URLSearchParams(location.search).has('reference-send');
const sentProof=document.createElement('output');sentProof.id='reference-send-proof';sentProof.hidden=true;sentProof.textContent='[]';if(referenceProof)document.body.appendChild(sentProof);
const fetchOriginal=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(!url.pathname.startsWith('/api/'))return fetchOriginal(input,init);
 if(sentTagsProof&&init?.method==='POST'&&url.pathname.endsWith('/messages')){
  const payload=JSON.parse(String(init.body));
  snapshot.messages.push({id:'sent-tags-'+snapshot.messages.length,sessionId:session.id,role:'user',text:payload.text,mentions:payload.mentions,createdAt:at(33+snapshot.messages.length)});snapshot.cursor++;
  return new Response('{}',{headers:{'Content-Type':'application/json'}});
 }
 if(referenceProof&&init?.method==='POST'&&url.pathname.endsWith('/messages')){const sent=JSON.parse(sentProof.textContent||'[]');sent.push(JSON.parse(String(init.body)));sentProof.textContent=JSON.stringify(sent);return new Response('{}',{headers:{'Content-Type':'application/json'}});}
 if((init?.method??'GET')!=='GET')return new Response(JSON.stringify({error:'README 演示只提供展示，不执行操作'}),{status:405,headers:{'Content-Type':'application/json'}});
 let value:unknown;
 const path=url.pathname;
 if(path==='/api/bootstrap')value=bootstrap;
 else if(path==='/api/catalog')value=catalog;
 else if(path.endsWith('/snapshot'))value=snapshot;
 else if(path.endsWith('/ai/reasoning'))value={modelId:model.modelId,effort:'',default:'',levels:[]};
 else if(path.endsWith('/ai/options'))value={profile:'core',multiAgentMode:'off',contextWindow:64000,maxOutput:8192,maxSteps:500,silentReadFiles:true,silentWriteFiles:false,silentReadSQL:true,silentCommands:true};
 else if(path==='/api/ai/presets'||path.endsWith('/ai/references')||path.endsWith('/terminals/available'))value=[];
 else if(path.endsWith('/sre'))value={enabled:true};
 else if(path.endsWith('/sre/tasks'))value={items:[task],nextCursor:''};
 else if(path.endsWith('/message-queue'))value=snapshot.messageQueue;
 else if(path==='/api/settings/model/available')value={models:[model.name],entries:[model],activeProviderId:model.providerId,activeModelId:model.modelId};
 else if(path==='/api/settings/skills')value={skills:[],roots:[]};
 else if(path==='/api/settings/mcp')value={servers:[]};
 else return new Response(JSON.stringify({error:'Not included in the read-only README fixture'}),{status:404,headers:{'Content-Type':'application/json'}});
 return new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
};
const demoStreams=new Set<DemoEventSource>();
class DemoEventSource extends EventTarget {
 static CONNECTING=0;static OPEN=1;static CLOSED=2;readyState=1;
 onopen:((e:Event)=>void)|null=null;onerror=null;onmessage:((e:MessageEvent<string>)=>void)|null=null;
 constructor(..._args:unknown[]){super();demoStreams.add(this);queueMicrotask(()=>this.onopen?.(new Event('open')));}
 close(){this.readyState=2;demoStreams.delete(this);}
}
window.EventSource=DemoEventSource as unknown as typeof EventSource;
window.lakeDesktopUpdates={platform:'macOS · Apple Silicon',command:async()=>({status:'current',currentVersion:'0.3.17',message:'当前已是最新版本',updateAvailable:false})};
createRoot(document.getElementById('root')!).render(<><App/><WindowsChrome/></>);

// Exercise the real App SSE -> snapshot -> header/composer path with safe local data.
if(new URLSearchParams(location.search).has('live-context')){
 snapshot.sre={enabled:false,tasks:[]};
 snapshot.ai!.context={modelId:model.modelId,window:100000,windowSource:'settings',budget:100000,inputBudget:100000,usedKnown:true,used:5000};
 const controls=document.createElement('nav');controls.setAttribute('aria-label','上下文实时验收');Object.assign(controls.style,{position:'fixed',top:'80px',right:'20px',zIndex:'100',display:'flex',gap:'8px'});
 for(const [value,label] of [['investigating','调查中'],['waiting_approval','待确认'],['completed','回复结束'],['failed','需要关注']] as const){
  const button=document.createElement('button');button.textContent=label;button.onclick=()=>{
   snapshot.session.status=value;
   snapshot.ai!.status=value==='investigating'?'running':value;
   snapshot.ai!.context!.used=(snapshot.ai!.context!.used??0)+5000;
   snapshot.cursor++;
   for(const stream of demoStreams)stream.onmessage?.(new MessageEvent('message',{data:JSON.stringify({sessionId:session.id,type:'session',seq:snapshot.cursor})}));
  };controls.appendChild(button);
 }
 document.body.appendChild(controls);
}
