// Real App with fictional input. No model, terminal, or resource calls.
import './workspace-heading';
import type {MessageQueue,SessionSnapshot} from '../../../shared/contracts';
const originalFetch=window.fetch.bind(window),BaseStream=window.EventSource,streams=new Set<EventSource>();
window.EventSource=class extends BaseStream {
 constructor(url:string|URL,options?:EventSourceInit){super(url,options);streams.add(this);}
 close(){streams.delete(this);super.close();}
} as typeof EventSource;
let sessionId='',stage=0,seq=100;
const root='supplement-root',at=new Date(Date.now()-10000).toISOString();
let queue:MessageQueue={paused:false,revision:1,lastError:'',items:['先确认有多大的数据','稍后再核对索引','最后整理结果'].map((text,i)=>({id:`supplement-${i}`,text,resourceIds:[],images:[],files:[],createdAt:at}))};
function emit(){seq++;for(const stream of streams)stream.onmessage?.(new MessageEvent('message',{data:JSON.stringify({sessionId,type:'session',seq})}));}
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(url.pathname.endsWith('/message-queue')){
  if(init?.method==='POST'){
   const data=JSON.parse(String(init.body));
   if(data.operation==='push'){queue={...queue,revision:queue.revision+1,items:queue.items.map(item=>item.id===data.id?{...item,supplementRootTurnId:root}:item)};stage=1;}
   if(data.operation==='reorder')queue={...queue,revision:queue.revision+1,items:data.ids.map((id:string)=>queue.items.find(item=>item.id===id)!)};
   emit();
  }
  return new Response(JSON.stringify(queue),{headers:{'Content-Type':'application/json'}});
 }
 const response=await originalFetch(input,init);
 if(!url.pathname.endsWith('/snapshot'))return response;
 const snapshot=await response.json() as SessionSnapshot;sessionId=snapshot.session.id;
 snapshot.sre={...snapshot.sre!,pilot:{enabled:false,autoAdvance:false,revision:1},tasks:[]};
 snapshot.messages=[{id:'original-user',sessionId,role:'user',text:'继续同步这两组数据',createdAt:at},...(stage===2?[{id:'supplement-0',sessionId,role:'user' as const,text:'先确认有多大的数据',createdAt:new Date().toISOString()}]:[])];
 snapshot.ai={...snapshot.ai!,session:sessionId,rootTurnId:root,status:'running',turnStartedAt:at,turnFinishedAt:'',agentRuns:[],cards:[],cardsOffset:0,totalCards:0};
 snapshot.replyTimings=[{messageId:'original-user',startedAt:at,finishedAt:'',status:'running'}];snapshot.messageQueue=queue;snapshot.session.status='investigating';snapshot.cursor=seq;
 return new Response(JSON.stringify(snapshot),{headers:{'Content-Type':'application/json'}});
};
document.addEventListener('keydown',event=>{
 if(event.key==='F6'){event.preventDefault();stage=2;queue={...queue,revision:queue.revision+1,items:queue.items.filter(item=>item.id!=='supplement-0')};emit();}
 if(event.key==='F7'){event.preventDefault();stage=0;queue={...queue,paused:true,lastError:'本轮未接入补充，消息已保留',revision:queue.revision+1,items:queue.items.map(item=>({...item,supplementRootTurnId:undefined}))};emit();}
});
