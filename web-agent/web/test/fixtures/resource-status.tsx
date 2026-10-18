// Real sidebar with synthetic terminal state; no backend or resource operations.
import './readme-workbench';
const previousFetch=window.fetch.bind(window);
const params=new URLSearchParams(location.search);
let reasoningEffort='';
const terminal={id:'synthetic-online-terminal',resourceId:'order-api',sessionId:'demo-session-0',status:new URLSearchParams(location.search).get('terminalStatus')||'ready',holder:'user',interactive:true,createdAt:'2026-10-18T08:00:00Z'};
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 if(params.has('reasoning')&&url.pathname.endsWith('/ai/reasoning')){
  if(init?.method==='POST'){
   document.documentElement.dataset.reasoningWrites=String(Number(document.documentElement.dataset.reasoningWrites??0)+1);
   await new Promise(resolve=>setTimeout(resolve,1200));
   reasoningEffort=JSON.parse(String(init.body)).effort;
  }
  return new Response(JSON.stringify({modelId:'deepseek-chat',effort:reasoningEffort,default:'medium',levels:['low','medium','high']}),{headers:{'Content-Type':'application/json'}});
 }
 const response=await previousFetch(input,init);
 if(url.pathname==='/api/catalog'||url.pathname.endsWith('/snapshot')){
  const value=await response.json();
  if(params.has('running')){if(value.ai)value.ai.status='running';if(value.session)value.session.status='investigating';}
  value.terminals=[terminal];
  for(const resource of value.resources??[])if(resource.id==='order-api')resource.name='京东云服务器36.151.150.63';
  return new Response(JSON.stringify(value),{status:response.status,headers:{'Content-Type':'application/json'}});
 }
 return response;
};
