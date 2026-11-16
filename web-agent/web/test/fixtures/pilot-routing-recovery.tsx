// Real presentation components with synthetic routing receipts; no backend traffic.
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {AICard,AIView,SessionSnapshot} from '../../../shared/contracts';
import {AITranscript} from '../../src/AIPanel';
import {ObjectReferencesProvider} from '../../src/AssistantMarkdown';
import {SuperRoleAvatar} from '../../src/SuperRoleAvatar';
import {ExecutionAgentIcon} from '../../src/ExecutionAgentIcon';
import {HeaderSweep} from '../../src/HeaderSweep';
import '../../src/styles.css';
import '../../src/pilotWorkspace.css';
import '../../src/specialistAvatars.css';
import '../../src/assistantProse.css';
import '../../src/floatingHeader.css';
import '../../src/conversationBubbles.css';
import '../../src/sreCollaboration.css';

const stages=['派单失败','派单已恢复','实际检查失败','等待确认','完成'] as const;
type Stage=typeof stages[number];
const sessionId='pilot-recovery-fixture',rootTurnId='fixture-root',eventId='fixture-human-event';
const started=Date.now()-14000,at=(seconds:number)=>new Date(started+seconds*1000).toISOString();
const request={event_id:eventId,part_key:'sample-check',action:'create',role_id:'fixture-specialist',predecessor_task_id:'fixture-previous-task',title:'复查隔离样例',quote:'再查一下样例'};
const failed:AICard={id:'route-failed',type:'operation',title:'route_work',status:'failed',at:at(2),content:"resource_ids must be a nonempty subset of this human event's selected resource IDs",data:{root_turn_id:rootTurnId,arguments:{...request,resource_ids:['fixture-resource'],reason:'复查原样例'}}};
const success:AICard={id:'route-corrected',type:'operation',title:'route_work',status:'completed',at:at(4),data:{root_turn_id:rootTurnId,arguments:{...request,reason:'沿用前次已授权的任务上下文'}},content:JSON.stringify({eventId,partKey:request.part_key,action:'create',roleId:request.role_id,workerId:'fixture-worker',taskId:'fixture-task',dispatch:{state:'queued',unresolvedOperations:0},handoff:{recorded:true}})};
function cardsFor(stage:Stage):AICard[]{
 if(stage==='派单失败')return [failed];
 const records:AICard[]=[{...failed,data:{...failed.data as object,routingRecovery:{kind:'corrected_resource_selection',recoveredBy:success.id}}},success];
 if(stage==='实际检查失败')records.push({id:'real-check-failed',type:'operation',title:'inspect_host',status:'failed',at:at(6),content:'样例连接失败：只读检查未取得结果。此项是真实业务失败的合成示例，不应被派单恢复覆盖。',data:{root_turn_id:rootTurnId,arguments:{resource_id:'fixture-resource'}}});
 if(stage==='等待确认')records.push({id:'pending-check',type:'operation',title:'inspect_host',status:'pending',at:at(6),content:'等待用户确认本地样例检查。',data:{root_turn_id:rootTurnId,arguments:{resource_id:'fixture-resource'}}});
 if(stage==='完成')records.push({id:'complete-reply',type:'message',status:'completed',at:at(8),content:'隔离样例核对已结束。首次派单失败经宿主确认的纠正调用恢复；原错误和回执仍保留在执行过程中。',data:{root_turn_id:rootTurnId}});
 return records;
}

// Accidental controls must fail locally instead of reaching a running Lake home.
window.fetch=async()=>{throw new Error('This isolated fixture does not allow backend requests.');};
function Fixture(){
 const [stage,setStage]=useState<Stage>('派单已恢复');
 const cards=cardsFor(stage),working=stage==='派单失败'||stage==='派单已恢复',waiting=stage==='等待确认';
 const motion=working?'working':stage==='完成'?'idle':'still';
 const ai:AIView={session:sessionId,profile:'',turns:1,usage:{input:0,output:0,total:0},rootTurnId,turnStartedAt:at(0),status:working?'running':waiting?'waiting_approval':stage==='实际检查失败'?'failed':'completed',cards,cardsOffset:0,totalCards:cards.length};
 const snapshot={session:{id:sessionId,projectId:'fixture-project',workspaceRole:'router'},cursor:1,messages:[{id:'fixture-user',sessionId,role:'user',text:'再查一下样例',createdAt:at(0)}],resources:[],actions:[],evidence:[],ai} as unknown as SessionSnapshot;
 const stateLabel=working?'处理中':waiting?'待确认':stage==='实际检查失败'?'检查失败':'已结束';
 return <main style={{maxWidth:880,margin:'28px auto',padding:'0 20px'}}>
  <header style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:20}}>
   {stages.map(value=><button type="button" key={value} aria-pressed={stage===value} onClick={()=>setStage(value)}>{value}</button>)}
   <button type="button" onClick={()=>{document.documentElement.dataset.theme=document.documentElement.dataset.theme==='dark'?'light':'dark';}}>切换主题</button>
  </header>
  <p data-stage={stage}>当前：{stage}。仅使用本地合成记录，不连接业务资源。</p>
  <div aria-label="Pilot 头像尺寸对照" style={{display:'flex',alignItems:'center',gap:24,flexWrap:'wrap',margin:'20px 0 28px'}}>
   {[14,20,22].map(size=><span key={size} style={{display:'inline-flex',alignItems:'center',gap:8}}><SuperRoleAvatar name="Pilot" pilot size={size} motion={motion}/><span>{size}px</span></span>)}
   <span role="img" aria-label="Agent 类型：Lake" style={{display:'inline-flex',alignItems:'center',gap:8,color:'var(--agent-coordinator)'}}><ExecutionAgentIcon size={14}/><span style={{color:'var(--text-secondary)'}}>原生 Lake · 14px</span></span>
  </div>
  <div data-header-preview style={{position:'relative',isolation:'isolate',width:'fit-content',maxWidth:'100%',minHeight:46,display:'flex',alignItems:'center',gap:12,padding:'0 16px',border:'1px solid var(--border)',borderRadius:22,marginBottom:28}}>
   <HeaderSweep active={working}/><span style={{position:'relative',display:'inline-flex'}}><SuperRoleAvatar name="Pilot" pilot size={20} motion={motion}/></span><strong style={{position:'relative'}}>Pilot</strong><span style={{position:'relative',color:'var(--text-secondary)'}}>{stateLabel}</span>
  </div>
  <ObjectReferencesProvider><AITranscript snapshot={snapshot} assistantIdentity={{name:'Pilot',pilot:true}}/></ObjectReferencesProvider>
 </main>;
}
document.documentElement.dataset.theme='light';
createRoot(document.getElementById('root')!).render(<Fixture/>);
