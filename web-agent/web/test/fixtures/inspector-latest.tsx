// Real App with fictional data only. F6 starts a blank turn, F7 adds its
// operation, F8 starts another blank turn; no backend/model/resource writes.
import './workspace-heading';
import type {SessionSnapshot} from '../../../shared/contracts';
const originalFetch=window.fetch.bind(window),BaseStream=window.EventSource;
const streams=new Set<EventSource>();
window.EventSource=class extends BaseStream {
 constructor(url:string|URL,options?:EventSourceInit){super(url,options);streams.add(this);}
 close(){streams.delete(this);super.close();}
} as typeof EventSource;
let stage=0,activeSession='';
const origin=Date.now()-120000,at=(seconds:number)=>new Date(origin+seconds*1000).toISOString();
window.fetch=async(input,init)=>{
 const response=await originalFetch(input,init),url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(!url.pathname.endsWith('/snapshot'))return response;
 const snapshot=await response.json() as SessionSnapshot,sessionId=snapshot.session.id;activeSession=sessionId;
 const pilot=new URLSearchParams(location.search).has('pilot');
 snapshot.sre={...snapshot.sre!,pilot:{enabled:pilot,autoAdvance:false,revision:1}};
 if(pilot)snapshot.sre.tasks=snapshot.sre.tasks.map(task=>({...task,createdAt:at(1),updatedAt:at(3)}));
 snapshot.messages=[{id:'old-user',sessionId,role:'user',text:'上一轮的资源检查',createdAt:at(0)},...(stage?[{id:'current-user',sessionId,role:'user' as const,text:'最新一轮的资源检查',createdAt:at(90)}]:[]),...(stage===3?[{id:'next-user',sessionId,role:'user' as const,text:'第三轮刚发出，还没有操作',createdAt:at(110)}]:[])];
 snapshot.replyTimings=[{messageId:'old-user',startedAt:at(0),finishedAt:at(3),status:'completed'},...(stage?[{messageId:'current-user',startedAt:at(90),status:stage===3?'completed':'running',finishedAt:stage===3?at(100):''}]:[]),...(stage===3?[{messageId:'next-user',startedAt:at(110),status:'running'}]:[])];
 snapshot.ai={...snapshot.ai!,session:sessionId,rootTurnId:stage===3?'next-root':stage?'current-root':'old-root',turnStartedAt:stage===3?at(110):stage?at(90):at(0),status:stage?'running':'completed',turnFinishedAt:stage?'':at(3),agentRuns:[],cards:[
 {id:'old-query',type:'operation',title:'list_assets',status:'completed',at:at(1),data:{target:'项目资源目录',arguments:{pattern:'旧任务资源'}},content:'上一轮的查询记录'},
 {id:'old-answer',type:'message',status:'completed',at:at(3),content:'上一轮检查已经结束。'},
 ...(stage>=2?[{id:'current-query',type:'operation',title:'list_assets',status:'completed',at:at(92),data:{target:'项目资源目录',arguments:{pattern:'最新任务资源'}},content:'最新一轮的查询记录'}]:[]),
 ],cardsOffset:0,totalCards:stage>=2?3:2};
 snapshot.session={...snapshot.session,status:stage?'investigating':'completed'};snapshot.cursor=100+stage;
 return new Response(JSON.stringify(snapshot),{headers:{'Content-Type':'application/json'}});
};
document.addEventListener('keydown',event=>{
 const next=({F6:1,F7:2,F8:3} as Record<string,number>)[event.key];if(!next)return;
 event.preventDefault();stage=next;
 for(const stream of streams)stream.onmessage?.(new MessageEvent('message',{data:JSON.stringify({sessionId:activeSession,type:'session',seq:100+stage})}));
});
