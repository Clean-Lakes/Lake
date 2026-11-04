import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import type {Message,SpecialistChannelEntry} from '../../../shared/contracts';
import {TranscriptMessage} from '../../src/AIPanel';
import {SpecialistChannelEntries} from '../../src/SpecialistChannel';
import {initializeFocusModality} from '../../src/focusModality';
import '../../src/styles.css';
import '../../src/conversationBubbles.css';
import '../../src/messageMentions.css';
import '../../src/specialistChannel.css';

if(new URLSearchParams(location.search).has('dark'))document.documentElement.dataset.theme='dark';
initializeFocusModality();
const at='2026-11-04T10:00:00Z';
const source:Message={id:'user-source',sessionId:'pilot',role:'user',text:'看一下两边的 MySQL 数据是否一致',createdAt:at};
const dispatch:Message={id:'dispatch-message',sessionId:'pilot',role:'assistant',text:'@数据库专员，请去做一下：核对两端 MySQL 数据一致性',createdAt:at,dispatch:{id:'decision',sourceMessageId:source.id,workerId:'worker',sessionId:'task-session',taskId:'task',roleId:'database',roleName:'数据库专员',channelSessionId:'database-channel',instruction:'核对两端 MySQL 数据一致性，并记录比较范围和实际差异。',action:'create'}};
const entries:SpecialistChannelEntry[]=[
 {id:'dispatch',sourceSessionId:'pilot',taskId:'task',workerId:'worker',message:dispatch,createdAt:at},
 {id:'reply',sourceSessionId:'task-session',taskId:'task',message:{id:'reply',sessionId:'task-session',role:'assistant',text:'我会先确认两端连接目标与比较范围，再读取实际数据核对。',createdAt:at},createdAt:at},
 {id:'direct',sourceSessionId:'database-channel',message:{id:'direct',sessionId:'database-channel',role:'user',text:'只比较业务表，先不要做修改。',createdAt:at},createdAt:at},
];
function Fixture(){
 const [selected,setSelected]=useState('');
 return <main style={{maxWidth:900,margin:'0 auto',padding:16,height:'100%',overflow:'auto'}}>
  <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(min(100%,360px),1fr))',gap:28}}>
   <section style={{minWidth:0}}><h2>Pilot 会话</h2><div className="ai-transcript" style={{marginTop:16}}><TranscriptMessage message={source} sessionId="pilot"/><TranscriptMessage message={dispatch} sessionId="pilot" assistantIdentity={{name:'Pilot',pilot:true}} onSpecialist={author=>setSelected(author.channelSessionId??'')}/></div></section>
   <section style={{minWidth:0}}><h2>数据库专员会话</h2><div className="ai-transcript specialist-channel" data-reply-avatar="hidden" style={{marginTop:16}}><SpecialistChannelEntries entries={entries} resources={[]}/></div></section>
  </div>
  <output aria-label="打开的专员">{selected}</output>
 </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
