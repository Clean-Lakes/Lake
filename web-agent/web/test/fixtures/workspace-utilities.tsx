// Full workbench with fictional project data and a local update bridge only.
import './floating-header';
const params=new URLSearchParams(location.search);
const tags=[{id:'operations',projectId:'demo-project',name:'运维排查',color:'green',createdAt:'2026-10-18T10:00:00Z'},{id:'database',projectId:'demo-project',name:'数据库',color:'purple',createdAt:'2026-10-18T10:00:00Z'}];
let glassQueue={paused:false,revision:1,lastError:'',items:Array.from({length:Math.max(1,Math.min(20,Number(params.get('queue-count'))||(params.has('many')?3:1)))},(_,i)=>({id:`glass-queue-${i}`,text:(params.has('queue-count')?`第 ${i+1} 条 · `:'')+['对比前后两次采样，确认负载变化。','再检查容器状态，并保留原始结果。','汇总检查结果，说明尚未确认的事项。'][i%3],resourceIds:[],references:[],images:[],files:[],createdAt:'2026-10-18T12:00:00Z'}))};
const previous=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(params.has('queue')&&url.pathname.endsWith('/message-queue')){
  const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  if((init?.method??'GET')==='GET')return json(glassQueue);
  const op=JSON.parse(String(init?.body));
  if(op.revision!==glassQueue.revision)return json({error:'队列已更新'},409);
  let items=glassQueue.items;
  if(op.operation==='remove')items=items.filter(item=>item.id!==op.id);
  if(op.operation==='edit')items=items.map(item=>item.id===op.id?{...item,text:op.text}:item);
  if(op.operation==='reorder')items=op.ids.map((id:string)=>items.find(item=>item.id===id));
  glassQueue={...glassQueue,items,revision:glassQueue.revision+1,paused:op.operation==='pause'?true:op.operation==='resume'?false:glassQueue.paused};
  return json(glassQueue);
 }
 if(params.has('reasoning')&&url.pathname.endsWith('/ai/reasoning'))return new Response(JSON.stringify({modelId:'deepseek-chat',effort:'',default:'medium',levels:['low','medium','high']}),{headers:{'Content-Type':'application/json'}});
 const response=await previous(input,init);
 if(!response.ok||url.pathname!=='/api/catalog'&&!url.pathname.endsWith('/snapshot'))return response;
 const data=await response.json();
 if(data.sessions){data.tags=tags;data.sessions[0].tags=[tags[0]];}
 if(data.session)data.session.tags=[tags[0]];
 if(data.session&&params.has('queue'))data.messageQueue=glassQueue;
 if(params.has('nested')){
  const folders=Array.from({length:3},(_,i)=>({id:`fixture-folder-${i}`,projectId:'demo-project',parentId:i?`fixture-folder-${i-1}`:'apps',kind:'folder',name:`嵌套目录 ${i+1}`,resourceId:null,position:10+i}));
  const host={id:'nested-host',projectId:'demo-project',name:'嵌套主机',kind:'ssh',description:'隔离交互验证',status:'available'};
  data.resources=[...(data.resources??[]),host];
  data.resourceTree=[...(data.resourceTree??[]),...folders,{id:'fixture-nested-host',projectId:'demo-project',parentId:'fixture-folder-2',kind:'resource',name:host.name,resourceId:host.id,position:0}];
 }
 if(params.has('scroll-sidebar')){
  const hosts=Array.from({length:36},(_,i)=>({id:`scroll-host-${i}`,projectId:'demo-project',name:`验证主机 192.0.2.${i+1}`,kind:'ssh',description:'隔离滚动验证',status:'available'}));
  data.resources=[...(data.resources??[]),...hosts];
  data.resourceTree=[...(data.resourceTree??[]),...hosts.map((host,i)=>({id:`scroll-node-${i}`,projectId:'demo-project',parentId:'apps',kind:'resource',name:host.name,resourceId:host.id,position:10+i}))];
 }
 return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
};
window.lakeDesktopUpdates={development:true,platform:'macOS · Apple Silicon',command:async()=>params.has('update')?{status:'available',currentVersion:'0.3.17',version:'0.3.18',message:'发现 Lake 0.3.18',updateAvailable:true}:{status:'current',currentVersion:'0.3.17',message:'当前已是最新版本',updateAvailable:false}};

if(params.has('queue')){
 const control=document.createElement('button');
 control.textContent='查看文字穿透';
 control.style.cssText='position:fixed;top:12px;right:14px;z-index:40;font-size:11px;color:var(--text-muted);border:1px solid var(--border);background:var(--surface);border-radius:8px;padding:7px';
 control.onclick=()=>{
  const scroller=document.querySelector<HTMLElement>('.conversation');
  const bubble=document.querySelector('.pending-message');
  const text=[...document.querySelectorAll('.timeline-list p')].at(-1);
  if(scroller&&bubble&&text){
   scroller.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
   scroller.scrollBy({top:text.getBoundingClientRect().top-bubble.getBoundingClientRect().top+4});
  }
 };
 document.body.appendChild(control);
}

// Exercise the real captured-pointer RAF path while a test-only press is held.
if(params.has('queue-scroll-test'))document.addEventListener('pointerdown',event=>{
 const handle=(event.target as Element).closest<HTMLButtonElement>('.pending-message-grip');
 const scroller=document.querySelector<HTMLElement>('.pending-message-list');
 if(!handle||!scroller)return;
 const bounds=scroller.getBoundingClientRect();
 window.setTimeout(()=>handle.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:event.pointerId,clientX:event.clientX,clientY:bounds.bottom-2,buttons:1})),50);
 window.setTimeout(()=>handle.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true,pointerId:event.pointerId})),350);
});
