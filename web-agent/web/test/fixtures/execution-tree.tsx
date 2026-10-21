// Fictional UI-only lifecycle. No backend, model calls or real resources.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AITranscript} from '../../src/AIPanel';
import type {AICard,Resource,SessionSnapshot} from '../../../shared/contracts';
import '../../src/styles.css';
import '../../src/theme.css';
import '../../src/conversationDirectory.css';
import '../../src/assistantProse.css';
const resources=[{id:'fixture-host',name:'演示服务器',kind:'ssh'},{id:'fixture-db',name:'演示数据库',kind:'database'}] as Resource[];
if(new URLSearchParams(location.search).get('theme')==='dark')document.documentElement.dataset.theme='dark';
// The summary endpoint is stubbed only in this fictional fixture. No model or
// resource request leaves this page. Capture each revision before the delay so
// a late reply can exercise the production component's stale-response guard.
let summaryStep=0,summaryCalls=0;
const summaryRequestProof=document.createElement('output');summaryRequestProof.id='summary-request-proof';summaryRequestProof.hidden=true;document.body.appendChild(summaryRequestProof);
const actualFetch=window.fetch.bind(window);
window.fetch=async(input,init)=>{
 if(String(input).endsWith('/ai/progress-summary')){
  const step=summaryStep,call=++summaryCalls;
  summaryRequestProof.textContent+=`request-${call}-step-${step}-pending\n`;
  await new Promise(resolve=>setTimeout(resolve,new URLSearchParams(location.search).has('summary-delay')&&call===1?8000:150));
  const text=step===0?'正在检查源端状态并准备导出，尚未取得迁移结果。':step===1?'源端导出已完成，任务已转入目标端恢复；尚待一致性验证。':'数据已完成导出和恢复，正在核对一致性；核验通过后即可确认迁移完成。';
  summaryRequestProof.textContent+=`request-${call}-step-${step}-finished\n`;
  return new Response(JSON.stringify({text,pending:false}),{headers:{'Content-Type':'application/json'}});
 }
 return actualFetch(input,init);
};
const start=new Date(Date.now()-22000).toISOString();
const operation=(id:string,title:string,resource:Resource):AICard=>({id,type:'operation',title,status:'completed',at:start,data:{resource_id:resource.id,target:resource.name,arguments:{command:'fixture-command-'+id}},content:'隔离演示结果 · '+id});
function Fixture(){
 const [ended,setEnded]=useState(false),[extra,setExtra]=useState(0);
 const duplicateProof=new URLSearchParams(location.search).has('dedup-proof');
 summaryStep=duplicateProof?1:extra;
 const stage=(id:string,content:string):AICard=>({id,type:'message',status:'completed',at:start,content});
 const joint=new URLSearchParams(location.search).has('joint-stages');
 const realtime=new URLSearchParams(location.search).has('live-summary');
 const source=operation('source-export','shell',resources[0]!);source.status=extra>0?'completed':'running';
 const target=operation('target-restore','shell',resources[1]!);target.status=extra>1?'completed':'running';
 const cards=duplicateProof?[operation('source-export-proof','shell',resources[0]!),stage('source-unique','源端导出与传输已完成，备份文件已校验。'),operation('source-copy-proof','shell',resources[0]!),stage('copied-source','传完并放好了。现在清掉目标端上一次恢复的库，再全量重建。'),operation('target-copy-proof','shell',resources[1]!),stage('copied-target','传完并放好了。现在清掉目标端上一次恢复的库，再全量重建。'),operation('target-restore-proof','shell',resources[1]!),stage('target-unique','目标端已清理，正在恢复业务库。'),...(ended?[stage('final','迁移已完成，最终校验通过。')]:[])]:realtime?[stage('plan','先确认当前状态。'),source,...(extra>0?[stage('exported','导出完成：26 个库，46.3 秒，压缩包 479 MB。'),target]:[]),...(extra>1?[stage('restored','恢复完成：26 个库均已返回成功结果，开始核对一致性。')]:[]),...(ended?[stage('final','本轮检查完成，最终总结已保留。')]:[])]:joint?[stage('plan',`继续按源库检查、镜像准备与目标验证的顺序推进。当前整体进度已更新 ${extra+1} 次。`),operation('host-check','shell',resources[0]!),operation('db-query','execute_sql',resources[1]!),stage('joint-result',`源库可以正常连接，缓冲池为 128 MB。目标端没有现成镜像，正在准备导出并传输。第 ${extra+1} 次阶段检查完成。`),...(ended?[stage('final','最终总结：演示资源检查完成，原始结果保留。')]:[])]:[operation('host-check','shell',resources[0]!),stage('export-stage','导出完成，用时 3.5 秒。'),operation('db-query','execute_sql',resources[1]!),stage('restore-stage','恢复完成，用时 13.6 秒，零报错。'),operation('host-read','read',resources[0]!),...Array.from({length:extra},(_,i)=>operation('extra-'+i,'shell',resources[0]!)),{id:'reply',type:'message',status:ended?'completed':'running',at:new Date(Date.now()+1000).toISOString(),content:ended?'检查完成，两个演示资源均正常。可以通过耗时栏回看完整记录。':`演示服务器第 ${extra+1} 轮一致性核对通过。原位更新本条进展，具体操作默认折叠。`}] as AICard[];
 const snapshot={session:{id:'fixture'},resources,messages:[{id:'question',sessionId:'fixture',role:'user',text:'检查这两个演示资源的状态',createdAt:start}],actions:[],replyTimings:[{messageId:'question',startedAt:start,status:ended?'completed':'running',finishedAt:ended?new Date().toISOString():''}],ai:{session:'fixture',turnStartedAt:start,status:ended?'completed':'running',cardsOffset:0,cards}} as SessionSnapshot;
 return <main style={{maxWidth:880,margin:'70px auto',padding:24}}><nav aria-label="隔离验收控制" style={{display:'flex',gap:12,marginBottom:36}}><button onClick={()=>setExtra(value=>value+1)}>追加操作</button><button onClick={()=>setEnded(true)}>完成会话</button><button onClick={()=>setEnded(false)}>继续会话</button></nav><AITranscript snapshot={snapshot}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);


// Bounded geometry samples across real viewport changes and lifecycle clicks.
// This records measurements only; it never corrects or clamps the production UI.
if(new URLSearchParams(location.search).has('resize-proof')){
 const output=document.createElement('output');output.id='activity-resize-proof';output.hidden=true;document.body.appendChild(output);
 const samples:unknown[]=[];let until=0,frame=0;
 const sample=()=>{
  frame=0;
  const mark=document.querySelector<HTMLElement>('.reply-activity');
  const text=document.querySelector<HTMLElement>('.is-overall .overall-progress-facts');
  const glyph=mark?.querySelector('svg');
  if(mark&&text&&glyph){
   const style=getComputedStyle(mark),textBox=text.getBoundingClientRect();
   const clip=text.closest('.settled-reply.is-archived')?.getBoundingClientRect();
   const paintedBottom=clip?Math.min(textBox.bottom,clip.bottom):textBox.bottom;
   samples.push({width:document.documentElement.clientWidth,gap:glyph.getBoundingClientRect().top-textBox.bottom,paintedGap:glyph.getBoundingClientRect().top-paintedBottom,textVisible:paintedBottom>textBox.top,opacity:style.opacity,leaving:mark.classList.contains('is-leaving')});output.textContent=JSON.stringify(samples.slice(-300));
  }
  if(performance.now()<until)frame=requestAnimationFrame(sample);
 };
 const record=()=>{until=performance.now()+650;if(!frame)frame=requestAnimationFrame(sample);};
 window.addEventListener('resize',record);document.addEventListener('click',record);record();
}


if(new URLSearchParams(location.search).has('live-summary')){
 const proof=document.createElement('output');proof.id='overall-summary-proof';proof.hidden=true;document.body.appendChild(proof);
 let first:Element|null=null;
 new MutationObserver(()=>{const slot=document.querySelector('.is-overall');if(!first&&slot)first=slot;proof.textContent=JSON.stringify({sameSlot:!!first&&slot===first,text:slot?.textContent});}).observe(document.getElementById('root')!,{subtree:true,childList:true,characterData:true});
}
