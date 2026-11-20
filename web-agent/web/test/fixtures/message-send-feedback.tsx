// Actual App with explicitly gated, fictional responses. No live model requests.
import './readme-workbench';
import type {Message,SessionSnapshot} from '../../../shared/contracts';
const inheritedFetch=window.fetch.bind(window);
const accepted:Message[]=[];
let releaseSend:(()=>void)|undefined,releaseSnapshot:(()=>void)|undefined;
let fail=false,calls=0,stops=0,gateSnapshot=false;
let running=new URLSearchParams(location.search).has('running');
const proof=document.createElement('output');proof.id='send-feedback-proof';proof.hidden=true;document.body.appendChild(proof);
const record=()=>{proof.textContent=JSON.stringify({calls,stops,accepted:accepted.length,waitingForSend:!!releaseSend,waitingForSnapshot:!!releaseSnapshot});};record();
window.addEventListener('keydown',event=>{
 if(event.key==='F8'){event.preventDefault();const release=releaseSend;releaseSend=undefined;release?.();record();}
 if(event.key==='F9'){event.preventDefault();fail=true;}
 if(event.key==='F6'){event.preventDefault();gateSnapshot=false;const release=releaseSnapshot;releaseSnapshot=undefined;release?.();record();}
});
window.fetch=async(input,init)=>{
 const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
 const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
 if(url.pathname.endsWith('/ai/abort')&&init?.method==='POST'){
  stops++;running=false;record();return json({});
 }
 if(url.pathname.endsWith('/attachments')&&init?.method==='POST'&&init.body instanceof File){
  return json({sourceId:'fixture-file',name:init.body.name,mimeType:'text/plain',sizeBytes:init.body.size},201);
 }
 if(url.pathname.endsWith('/messages')&&init?.method==='POST'){
  calls++;const payload=JSON.parse(String(init.body));
  await new Promise<void>(resolve=>{releaseSend=resolve;record();});
  if(fail){fail=false;return json({error:'演示发送失败，草稿保留'},503);}
  const message:Message={id:`accepted-${calls}`,sessionId:url.pathname.split('/')[3]!,role:'user',text:payload.text,createdAt:new Date().toISOString()};
  accepted.push(message);running=true;gateSnapshot=true;record();return json(message,202);
 }
 const response=await inheritedFetch(input,init);
 if(url.pathname.endsWith('/snapshot')){
  const snapshot:SessionSnapshot=await response.json();
  if(gateSnapshot)await new Promise<void>(resolve=>{releaseSnapshot=resolve;record();});
  snapshot.session.status=running?'investigating':'completed';
  snapshot.ai!.status=running?'running':'completed';
  snapshot.ai!.pending=undefined;snapshot.ai!.question=undefined;snapshot.ai!.agentRuns=[];
  snapshot.sre={enabled:false,tasks:[]};snapshot.messages.push(...accepted);snapshot.cursor+=accepted.length;
  return json(snapshot);
 }
 return response;
};
